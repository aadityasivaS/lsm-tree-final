import { LSMEngine } from "./lsm-engine.js";

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function immutableCopy(value) {
  return freezeDeep(structuredClone(value));
}

// Captures the engine after each emitted event so the UI can inspect history safely.
export class StepEngine {
  constructor(options = {}) {
    this.listeners = new Set();
    this.playTimer = null;
    this.history = [];
    this.cursor = 0;
    this.engine = new LSMEngine({ ...options, onEvent: (event, state) => this._capture(event, state) });
    const initialState = this.engine.snapshot();
    this.history.push(immutableCopy({
      index: 0,
      event: { type: "initial", label: "Ready" },
      caption: "Ready for an operation.",
      state: { ...initialState, caption: "Ready for an operation.", visualizationHighlights: initialState.visualization },
      timestamp: 0,
    }));
  }

  _capture(event, state) {
    const caption = event.caption || event.label || event.type.replaceAll("_", " ").toLowerCase();
    const entry = immutableCopy({
      index: this.history.length,
      event,
      caption,
      state: { ...state, caption, visualizationHighlights: state.visualization },
      timestamp: Date.now(),
    });
    this.history.push(entry);
    this.cursor = this.history.length - 1;
    this._notify();
  }

  _notify() {
    for (const listener of this.listeners) listener(this.current(), this.history.length);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  current() {
    return this.history[this.cursor];
  }

  entries() {
    return this.history;
  }

  select(index) {
    const parsed = Number(index);
    const bounded = Number.isFinite(parsed)
      ? Math.max(0, Math.min(this.history.length - 1, Math.trunc(parsed)))
      : this.cursor;
    if (bounded === this.cursor) return this.current();
    this.cursor = bounded;
    this.engine.restore(this.current().state);
    this._notify();
    return this.current();
  }

  step(amount = 1) {
    return this.select(this.cursor + amount);
  }

  execute(action) {
    this.pause();
    this._validateAction(action);
    if (this.cursor < this.history.length - 1) {
      this.history = this.history.slice(0, this.cursor + 1);
      this.engine.restore(this.current().state);
    }
    const beforeCount = this.history.length;
    let result;
    switch (action.type) {
      case "put":
        result = this.engine.put(action.key, action.value);
        break;
      case "delete":
        result = this.engine.delete(action.key);
        break;
      case "flush":
        result = this.engine.flush();
        break;
      case "compact":
        result = this.engine.compact();
        break;
      case "strategy":
        result = this.engine.setStrategy(action.strategy);
        break;
      case "crash-recover":
        result = this.engine.crashRecover();
        break;
      case "get":
        result = this.engine.get(action.key);
        break;
      case "scan":
        result = this.engine.scan(action.startKey, action.endKey);
        break;
      case "random-batch":
        result = this.insertRandomBatch(action.seed ?? 20261024, action.count ?? 20);
        break;
      default:
        throw new RangeError(`Unknown action type: ${action.type}`);
    }
    if (this.history.length === beforeCount) {
      this._capture({
        type: "NO_CHANGE",
        caption: result === false ? "No eligible state change occurred." : "Operation completed.",
        action: immutableCopy(action),
        result: immutableCopy(result),
      }, this.engine.snapshot());
    }
    return result;
  }

  _validateAction(action) {
    if (!action || typeof action !== "object" || typeof action.type !== "string") {
      throw new TypeError("An action with a type is required.");
    }
    if (action.type === "random-batch" && (!Number.isInteger(action.seed ?? 20261024) || (action.count ?? 20) !== 20)) {
      throw new RangeError("Random insertion requires an integer seed and exactly 20 records.");
    }
    if (["put", "delete", "get"].includes(action.type)) {
      if (typeof action.key !== "string" || action.key.length === 0) throw new TypeError("Keys must be non-empty strings.");
      if (action.type === "put" && typeof action.value !== "string") throw new TypeError("Values must be strings.");
    }
    if (action.type === "scan") {
      if (typeof action.startKey !== "string" || action.startKey.length === 0
        || typeof action.endKey !== "string" || action.endKey.length === 0) {
        throw new TypeError("Range boundaries must be non-empty strings.");
      }
      if (action.startKey > action.endKey) throw new RangeError("Range start must be <= range end.");
    }
    if (action.type === "strategy" && !["leveled", "size-tiered"].includes(action.strategy)) {
      throw new RangeError("Strategy must be 'leveled' or 'size-tiered'.");
    }
    const requiredTypes = new Set(["put", "delete", "get", "scan", "flush", "compact", "strategy", "crash-recover", "random-batch"]);
    if (!requiredTypes.has(action.type)) throw new RangeError(`Unknown action type: ${action.type}`);
  }

  play(intervalMs = 700) {
    this.pause();
    if (this.cursor >= this.history.length - 1) return false;
    this.playTimer = setInterval(() => {
      if (this.cursor >= this.history.length - 1) {
        this.pause();
        this._notify();
        return;
      }
      this.step(1);
      if (this.cursor >= this.history.length - 1) {
        this.pause();
        this._notify();
      }
    }, Math.max(80, intervalMs));
    return true;
  }

  pause() {
    if (this.playTimer !== null) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
  }

  isPlaying() {
    return this.playTimer !== null;
  }

  reset() {
    this.pause();
    this.history = this.history.slice(0, 1);
    this.cursor = 0;
    this.engine.restore(this.current().state);
    this._notify();
    return this.current();
  }

  insertRandomBatch(seed = 20261024, count = 20) {
    if (!Number.isInteger(seed) || !Number.isInteger(count) || count !== 20) {
      throw new RangeError("Random insertion requires an integer seed and exactly 20 records.");
    }
    let randomState = seed >>> 0;
    const records = [];
    for (let index = 0; index < 20; index += 1) {
      randomState ^= randomState << 13;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      randomState >>>= 0;
      const key = `rnd-${seed}-${String(index + 1).padStart(2, "0")}-${randomState.toString(16).padStart(8, "0")}`;
      records.push(this.engine.put(key, `value-${randomState.toString(16).padStart(8, "0")}`));
    }
    return records;
  }
}

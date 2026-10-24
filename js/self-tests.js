import { LSMEngine } from "./lsm-engine.js";
import { StepEngine } from "./step-engine.js";

function deepEqual(actual, expected) {
  if (actual instanceof Set && expected instanceof Set) {
    return actual.size === expected.size && [...actual].every((value) => expected.has(value));
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length && actual.every((value, index) => deepEqual(value, expected[index]));
  }
  if (actual && expected && typeof actual === "object" && typeof expected === "object") {
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    return deepEqual(actualKeys, expectedKeys) && actualKeys.every((key) => deepEqual(actual[key], expected[key]));
  }
  return Object.is(actual, expected);
}

const assert = {
  equal(actual, expected, message = "") {
    if (!Object.is(actual, expected)) throw new Error(message || `Expected ${String(expected)}, received ${String(actual)}.`);
  },
  deepEqual(actual, expected, message = "") {
    if (!deepEqual(actual, expected)) throw new Error(message || "Values did not match expected structure.");
  },
  ok(value, message = "Expected condition to be true.") {
    if (!value) throw new Error(message);
  },
};

function createEngine(options = {}) {
  const events = [];
  const engine = new LSMEngine({ ...options, onEvent: (event, state) => events.push({ event, state }) });
  return { engine, events };
}

function putMany(engine, entries) {
  for (const [key, value] of entries) engine.put(key, value);
}

const tests = [
  {
    name: "PUT then GET",
    run() {
      const { engine } = createEngine();
      engine.put("course", "DBMS");
      assert.equal(engine.get("course").value, "DBMS");
    },
  },
  {
    name: "Overwrite resolves newest sequence",
    run() {
      const { engine } = createEngine();
      engine.put("key", "older");
      engine.flush();
      engine.put("key", "newer");
      engine.flush();
      assert.equal(engine.get("key").value, "newer");
      assert.equal(engine.get("key").seq, 2);
    },
  },
  {
    name: "DELETE returns NOT_FOUND",
    run() {
      const { engine, events } = createEngine();
      engine.put("key", "value");
      engine.flush();
      engine.delete("key");
      assert.equal(engine.get("key"), null);
      assert.ok(events.some(({ event }) => event.type === "NOT_FOUND" && event.key === "key"));
    },
  },
  {
    name: "Sorted range excludes tombstones",
    run() {
      const { engine } = createEngine();
      putMany(engine, [["z", "last"], ["a", "first"], ["m", "middle"], ["b", "second"]]);
      engine.delete("m");
      const results = engine.scan("a", "z");
      assert.deepEqual(results.map((record) => record.key), ["a", "b", "z"]);
    },
  },
  {
    name: "Full MemTable flushes before fifth key",
    run() {
      const { engine, events } = createEngine();
      putMany(engine, [["a", "1"], ["b", "2"], ["c", "3"], ["d", "4"]]);
      assert.equal(engine.snapshot().levels[0].length, 0);
      engine.put("e", "5");
      const state = engine.snapshot();
      assert.equal(state.levels[0].length, 1);
      assert.equal(state.tables[state.levels[0][0]].records.length, 4);
      assert.deepEqual(state.memtable.map((record) => record.key), ["e"]);
      assert.ok(events.some(({ event }) => event.type === "MEMTABLE_FULL"));
      assert.equal(state.flushCheckpoint, 4);
    },
  },
  {
    name: "SSTable blocks, index, footer agree",
    run() {
      const { engine } = createEngine({ memtableCapacity: 10 });
      putMany(engine, [["e", "5"], ["a", "1"], ["d", "4"], ["b", "2"], ["c", "3"]]);
      engine.flush();
      const table = engine.snapshot().tables[engine.snapshot().levels[0][0]];
      const blockRecords = table.blocks.flat();
      assert.deepEqual(blockRecords.map((record) => record.key), table.records.map((record) => record.key));
      assert.equal(table.footer.recordCount, table.records.length);
      assert.equal(table.footer.minKey, table.records[0].key);
      assert.equal(table.footer.maxKey, table.records.at(-1).key);
      assert.deepEqual(table.sparseIndex.map((entry) => entry.key), table.blocks.map((block) => block[0].key));
      assert.deepEqual(table.sparseIndex.map((entry) => entry.blockIndex), table.blocks.map((_, index) => index));
    },
  },
  {
    name: "Bloom filter positives are verified",
    run() {
      const { engine } = createEngine({ memtableCapacity: 30 });
      for (let index = 0; index < 20; index += 1) {
        const number = 100 + index * 2;
        engine.put(`k${number}`, `v${number}`);
      }
      engine.flush();
      const tableId = engine.snapshot().levels[0][0];
      const existing = engine.snapshot().tables[tableId].records;
      for (const record of existing) {
        const check = engine.inspectBloom(tableId, record.key);
        assert.equal(check.mayContain, true, `Bloom false negative for ${record.key}`);
        assert.equal(check.verifiedPresent, true);
      }
      let falsePositiveVerified = false;
      for (let suffix = 0; suffix < 2000 && !falsePositiveVerified; suffix += 1) {
        const key = `k100x${String(suffix).padStart(4, "0")}`;
        const check = engine.inspectBloom(tableId, key);
        if (check.mayContain) {
          assert.equal(check.record, null);
          assert.equal(check.verifiedPresent, false);
          assert.equal(engine.get(key), null, "Bloom positive must be checked against records");
          falsePositiveVerified = true;
        }
      }
      assert.equal(falsePositiveVerified, true, "Expected deterministic candidate set to include a Bloom false positive");
    },
  },
  {
    name: "Leveled and tiered thresholds",
    run() {
      const leveled = createEngine({ memtableCapacity: 1 }).engine;
      leveled.put("a", "1");
      leveled.flush();
      assert.equal(leveled.compact(), false, "One L0 file must not trigger leveled compaction");
      leveled.put("b", "2");
      leveled.flush();
      assert.equal(leveled.compact(), true, "Two L0 files must trigger leveled compaction");
      assert.equal(leveled.snapshot().levels[1].length, 1);

      const tiered = createEngine({ memtableCapacity: 1 }).engine;
      tiered.setStrategy("size-tiered");
      for (const key of ["a", "b"]) {
        tiered.put(key, key);
        tiered.flush();
      }
      assert.equal(tiered.compact(), false, "Two same-sized files are below the tier threshold");
      tiered.put("c", "c");
      tiered.flush();
      assert.equal(tiered.compact(), true, "Three similarly sized files trigger size-tiered compaction");
      assert.equal(tiered.snapshot().levels[1].length, 1);
    },
  },
  {
    name: "Compaction keeps tombstone winner",
    run() {
      const { engine } = createEngine({ memtableCapacity: 1 });
      engine.put("key", "old");
      engine.flush();
      engine.put("key", "newest");
      engine.flush();
      assert.equal(engine.compact(), true);
      assert.equal(engine.get("key").value, "newest");
      engine.delete("key");
      engine.flush();
      engine.put("filler", "value");
      engine.flush();
      assert.equal(engine.compact(), true);
      assert.equal(engine.compact(), true);
      assert.equal(engine.get("key"), null);
      assert.ok(engine.snapshot().levels[1].some((id) => engine.snapshot().tables[id].records.some((record) => record.tombstone)));
      engine.crashRecover();
      assert.equal(engine.get("key"), null, "Recovery after compaction must not resurrect the older value");
    },
  },
  {
    name: "L3 tombstone drop stays deleted after recovery",
    run() {
      const { engine } = createEngine({ memtableCapacity: 1 });
      engine.setStrategy("size-tiered");
      engine.put("m", "old");
      engine.flush();
      engine.delete("m");
      engine.flush();
      engine.put("a-filler", "filler");
      engine.flush();
      assert.equal(engine.compact(), true);

      let groupNumber = 0;
      const createLevelOneRun = (recordCount) => {
        groupNumber += 1;
        const prefix = `z${String(groupNumber).padStart(2, "0")}`;
        const keys = recordCount === 2
          ? [`${prefix}-a`, `${prefix}-a`, `${prefix}-b`]
          : [`${prefix}-a`, `${prefix}-b`, `${prefix}-c`];
        for (const key of keys) {
          engine.put(key, key);
          engine.flush();
        }
        assert.equal(engine.compact(), true);
      };

      for (let levelTwoFile = 0; levelTwoFile < 3; levelTwoFile += 1) {
        createLevelOneRun(2);
        createLevelOneRun(3);
        createLevelOneRun(3);
        assert.equal(engine.compact(), true);
      }
      assert.equal(engine.snapshot().levels[2].length, 3);
      assert.equal(engine.compact(), true);
      const state = engine.snapshot();
      assert.equal(state.levels[3].length, 1);
      assert.equal(state.levels.flat().flatMap((id) => state.tables[id].records).some((record) => record.key === "m"), false);
      assert.equal(engine.get("m"), null);
      const recovery = engine.crashRecover();
      assert.equal(recovery.replayed, 0);
      assert.equal(engine.get("m"), null);
    },
  },
  {
    name: "Physical SSTable writes count once",
    run() {
      const { engine } = createEngine({ memtableCapacity: 1 });
      engine.put("key", "old");
      engine.flush();
      engine.put("key", "new");
      engine.flush();
      assert.equal(engine.snapshot().counters.physicalSstableRecordsWritten, 2);
      engine.compact();
      assert.equal(engine.snapshot().counters.physicalSstableRecordsWritten, 3, "Compaction output contributes one physical record write");
    },
  },
  {
    name: "Recovery replays only beyond checkpoint",
    run() {
      const { engine, events } = createEngine();
      putMany(engine, [["a", "1"], ["b", "2"], ["c", "3"]]);
      engine.flush();
      const checkpoint = engine.snapshot().flushCheckpoint;
      engine.put("d", "4");
      engine.delete("b");
      const result = engine.crashRecover();
      const replayed = events.filter(({ event }) => event.type === "REPLAY" && event.phase === "record");
      assert.equal(result.replayed, 2);
      assert.ok(replayed.every(({ event }) => event.record.seq > checkpoint));
      assert.equal(engine.get("a").value, "1");
      assert.equal(engine.get("d").value, "4");
      assert.equal(engine.get("b"), null);
      engine.crashRecover();
      assert.equal(engine.snapshot().memtable.length, 2, "Repeated replay replaces the same keys instead of duplicating them");
      assert.equal(engine.get("b"), null);
    },
  },
  {
    name: "Manifest IDs match live tables",
    run() {
      const { engine } = createEngine({ memtableCapacity: 1 });
      engine.put("a", "1");
      engine.flush();
      engine.put("b", "2");
      engine.flush();
      engine.compact();
      const state = engine.snapshot();
      assert.deepEqual(new Set(state.manifest.liveIds), new Set(state.levels.flat()));
      assert.ok(state.manifest.liveIds.every((id) => state.tables[id]));
      assert.deepEqual(state.manifest.history.at(-1).liveIds, state.manifest.liveIds);
    },
  },
  {
    name: "Prev and Next restore exact snapshots",
    run() {
      const stepper = new StepEngine();
      stepper.execute({ type: "put", key: "a", value: "1" });
      stepper.execute({ type: "put", key: "b", value: "2" });
      const expected = stepper.entries().map((entry) => entry.state);
      stepper.select(2);
      assert.deepEqual(stepper.engine.snapshot(), expected[2]);
      stepper.step(1);
      assert.deepEqual(stepper.engine.snapshot(), expected[3]);
      assert.ok(Object.isFrozen(stepper.current()) && Object.isFrozen(stepper.current().state));
    },
  },
  {
    name: "Playback pauses and branch truncates future",
    async run() {
      const stepper = new StepEngine();
      stepper.execute({ type: "put", key: "a", value: "1" });
      stepper.execute({ type: "put", key: "b", value: "2" });
      const oldLength = stepper.entries().length;
      stepper.select(0);
      assert.equal(stepper.play(80), true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(stepper.isPlaying(), true, "Playback should still be active before the next action");
      assert.ok(stepper.current().index > 0);
      const branchAt = stepper.current().index;
      stepper.execute({ type: "put", key: "branch", value: "3" });
      assert.equal(stepper.isPlaying(), false, "Accepting an operation must pause playback");
      assert.ok(stepper.entries().length < oldLength + 3);
      assert.equal(stepper.engine.get("branch").value, "3");
      assert.equal(stepper.engine.get("b"), null);
      assert.ok(branchAt < oldLength - 1);
    },
  },
  {
    name: "Reset clears state and counters",
    run() {
      const stepper = new StepEngine();
      stepper.execute({ type: "put", key: "a", value: "1" });
      stepper.execute({ type: "get", key: "a" });
      stepper.reset();
      const state = stepper.engine.snapshot();
      assert.equal(stepper.entries().length, 1);
      assert.equal(state.wal.length, 0);
      assert.equal(state.memtable.length, 0);
      assert.equal(state.levels.flat().length, 0);
      assert.ok(Object.values(state.counters).every((counter) => counter === 0));
    },
  },
  {
    name: "Invalid action preserves future history",
    run() {
      const stepper = new StepEngine();
      stepper.execute({ type: "put", key: "a", value: "1" });
      const history = stepper.entries();
      stepper.select(0);
      let rejected = false;
      try {
        stepper.execute({ type: "put", key: "", value: "invalid" });
      } catch {
        rejected = true;
      }
      assert.equal(rejected, true);
      assert.equal(stepper.entries(), history, "Rejected operations must not replace or truncate history");
      assert.equal(stepper.entries().length, 4);
      assert.equal(stepper.engine.snapshot().wal.length, 0);
    },
  },
  {
    name: "Random batch is exactly 20 and reproducible",
    run() {
      const first = new StepEngine();
      const second = new StepEngine();
      const firstRecords = first.execute({ type: "random-batch", seed: 77 });
      const secondRecords = second.execute({ type: "random-batch", seed: 77 });
      assert.equal(firstRecords.length, 20);
      assert.equal(first.engine.snapshot().counters.writes, 20);
      assert.equal(first.engine.snapshot().wal.length, 20);
      assert.equal(new Set(firstRecords.map((record) => record.key)).size, 20);
      assert.deepEqual(firstRecords, secondRecords);
    },
  },
];

export async function runSelfTests() {
  const results = [];
  for (const test of tests) {
    try {
      await test.run();
      results.push({ name: test.name, status: "PASS", reason: "Assertions passed against isolated engine state." });
    } catch (error) {
      results.push({ name: test.name, status: "FAIL", reason: error.message || String(error) });
    }
  }
  return results;
}

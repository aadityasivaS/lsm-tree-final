const MAX_LEVEL = 8;
const BLOCK_SIZE = 4;

function compareKeys(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("Keys must be non-empty strings.");
  }
}

function cloneRecord(record) {
  return { ...record };
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function hashKey(key, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

class SkipNode {
  constructor(record, level) {
    this.record = record;
    this.forward = Array(level + 1).fill(null);
  }
}

// A seeded skip list keeps insertion shapes reproducible for demonstrations.
class SkipList {
  constructor(seed = 0x5eed) {
    this.head = new SkipNode(null, MAX_LEVEL);
    this.level = 0;
    this.size = 0;
    this.randomState = seed >>> 0;
  }

  _randomLevel() {
    let level = 0;
    while (level < MAX_LEVEL) {
      this.randomState ^= this.randomState << 13;
      this.randomState ^= this.randomState >>> 17;
      this.randomState ^= this.randomState << 5;
      this.randomState >>>= 0;
      if ((this.randomState & 1) === 0) break;
      level += 1;
    }
    return level;
  }

  find(key) {
    let node = this.head;
    for (let level = this.level; level >= 0; level -= 1) {
      while (node.forward[level] && compareKeys(node.forward[level].record.key, key) < 0) {
        node = node.forward[level];
      }
    }
    node = node.forward[0];
    return node && node.record.key === key ? node.record : null;
  }

  set(record) {
    const update = Array(MAX_LEVEL + 1).fill(null);
    let node = this.head;
    for (let level = this.level; level >= 0; level -= 1) {
      while (node.forward[level] && compareKeys(node.forward[level].record.key, record.key) < 0) {
        node = node.forward[level];
      }
      update[level] = node;
    }

    const existing = node.forward[0];
    if (existing && existing.record.key === record.key) {
      existing.record = cloneRecord(record);
      return false;
    }

    const nodeLevel = this._randomLevel();
    if (nodeLevel > this.level) {
      for (let level = this.level + 1; level <= nodeLevel; level += 1) update[level] = this.head;
      this.level = nodeLevel;
    }
    const inserted = new SkipNode(cloneRecord(record), nodeLevel);
    for (let level = 0; level <= nodeLevel; level += 1) {
      inserted.forward[level] = update[level].forward[level];
      update[level].forward[level] = inserted;
    }
    this.size += 1;
    return true;
  }

  entries() {
    const result = [];
    let node = this.head.forward[0];
    while (node) {
      result.push(cloneRecord(node.record));
      node = node.forward[0];
    }
    return result;
  }

  structure() {
    const nodes = [];
    let node = this.head.forward[0];
    while (node) {
      nodes.push({ record: cloneRecord(node.record), level: node.forward.length - 1 });
      node = node.forward[0];
    }
    return { nodes, level: this.level, randomState: this.randomState };
  }

  restore(structure) {
    this.head = new SkipNode(null, MAX_LEVEL);
    this.level = structure.level;
    this.size = structure.nodes.length;
    this.randomState = structure.randomState;
    const tails = Array(MAX_LEVEL + 1).fill(this.head);
    for (const item of structure.nodes) {
      const node = new SkipNode(cloneRecord(item.record), item.level);
      for (let level = 0; level <= item.level; level += 1) {
        tails[level].forward[level] = node;
        tails[level] = node;
      }
    }
  }
}

function createBloomFilter(records) {
  const bitCount = Math.max(64, records.length * 10);
  const bits = Array(bitCount).fill(0);
  const hashCount = 3;
  for (const record of records) {
    const first = hashKey(record.key, 2166136261);
    const second = hashKey(record.key, 0x9e3779b9) | 1;
    for (let index = 0; index < hashCount; index += 1) {
      bits[(first + index * second) % bitCount] = 1;
    }
  }
  return { bits, hashCount };
}

function bloomMayContain(filter, key) {
  const bitCount = filter.bits.length;
  const first = hashKey(key, 2166136261);
  const second = hashKey(key, 0x9e3779b9) | 1;
  for (let index = 0; index < filter.hashCount; index += 1) {
    if (filter.bits[(first + index * second) % bitCount] === 0) return false;
  }
  return true;
}

function recordAt(table, key) {
  let low = 0;
  let high = table.records.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const comparison = compareKeys(table.records[middle].key, key);
    if (comparison === 0) return table.records[middle];
    if (comparison < 0) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}

export class LSMEngine {
  constructor({ memtableCapacity = 4, seed = 0x5eed, onEvent = null } = {}) {
    if (!Number.isInteger(memtableCapacity) || memtableCapacity < 1) {
      throw new RangeError("MemTable capacity must be a positive integer.");
    }
    this.memtableCapacity = memtableCapacity;
    this.seed = seed;
    this.onEvent = onEvent;
    this.strategy = "leveled";
    this.wal = [];
    this.nextSequence = 1;
    this.nextTableId = 1;
    this.memtable = new SkipList(seed);
    this.tables = new Map();
    this.levels = [[], [], [], []];
    this.manifestVersion = 0;
    this.manifestHistory = [];
    this.durableManifestHistory = [];
    this.flushCheckpoint = 0;
    this.durableLevels = [[], [], [], []];
    this.durableTableIds = [];
    this.durableManifestVersion = 0;
    this.recoveryCount = 0;
    this.counters = {
      writes: 0,
      deletes: 0,
      walRecords: 0,
      flushes: 0,
      compactions: 0,
      gets: 0,
      scans: 0,
      replays: 0,
      sstableChecks: 0,
      physicalSstableReads: 0,
      physicalSstableRecordsWritten: 0,
    };
    this.visualization = { type: "INITIAL", key: null, tableId: null, fileIds: [] };
    this.currentCaption = "Ready for an operation.";
  }

  _emit(type, details = {}) {
    const event = { type, caption: details.caption || this._caption(type, details), ...details };
    this.currentCaption = event.caption;
    this.visualization = {
      type,
      key: event.key ?? event.record?.key ?? null,
      tableId: event.tableId ?? null,
      fileIds: [...(event.fileIds || event.inputIds || [])],
      outcome: event.outcome || null,
    };
    if (this.onEvent) this.onEvent(freezeDeep(event), freezeDeep(this.snapshot()));
  }

  _caption(type, details) {
    const key = details.key || details.record?.key;
    const captions = {
      PUT: `PUT accepted for ${key}.`,
      DELETE: `DELETE tombstone accepted for ${key}.`,
      WAL_APPEND: `WAL appended sequence ${details.record?.seq}.`,
      MEMTABLE_FULL: "The MemTable is full; flush it before inserting a new key.",
      MEMTABLE_UPDATE: `MemTable now holds the latest version of ${key}.`,
      FLUSH: details.tableId ? `Flushed MemTable into ${details.tableId} at L0.` : "MemTable was empty; no flush was needed.",
      SSTABLE_CREATED: `Created immutable ${details.tableId} at L${details.level}.`,
      MANIFEST_UPDATE: `Manifest version ${details.version} now names the live SSTables.`,
      COMPACT_START: `Compaction is starting from L${details.sourceLevel} toward L${details.destinationLevel}.`,
      MERGE: `Merged ${details.recordCount} candidate records and resolved versions by sequence number.`,
      COMPACT_END: `Compaction committed${details.outputId ? ` as ${details.outputId}` : " with no output file"}.`,
      COMPACT_SKIPPED: `No files qualify for ${details.strategy} compaction.`,
      GET_CHECK: `Checking ${details.tableId || "MemTable"} for ${key}.`,
      BLOOM_SKIP: `Skipped ${details.tableId}; ${details.reason === "range" ? "the key is outside its range" : "the Bloom filter ruled out the key"}.`,
      FOUND: `Found the newest ${details.tombstone ? "tombstone" : "value"} for ${key}${details.source ? ` in ${details.source}` : ""}.`,
      NOT_FOUND: `No live value exists for ${key}.`,
      RANGE_SCAN: `Scanned the inclusive range ${details.startKey} through ${details.endKey}.`,
      CRASH: "Crash simulated: volatile state was discarded and durable state restored.",
      REPLAY: details.phase === "start"
        ? `Recovery will replay ${details.replayCount} records beyond checkpoint ${details.checkpoint}.`
        : details.phase === "complete"
          ? `WAL replay complete; restored ${details.replayed} records.`
          : `Replayed WAL sequence ${details.record?.seq}.`,
      STRATEGY: `Compaction strategy changed to ${details.strategy}.`,
    };
    return captions[type] || type.replaceAll("_", " ").toLowerCase();
  }

  _publishManifest(reason) {
    this.manifestVersion += 1;
    const liveIds = this.levels.flat();
    const manifest = { version: this.manifestVersion, reason, liveIds: [...liveIds] };
    this.manifestHistory.push(manifest);
    this._emit("MANIFEST_UPDATE", { version: manifest.version, reason, liveIds: [...liveIds] });
  }

  _persistLayout() {
    this.durableLevels = this.levels.map((level) => [...level]);
    this.durableTableIds = [...this.tables.keys()];
    this.durableManifestVersion = this.manifestVersion;
    this.durableManifestHistory = this.manifestHistory.map((entry) => ({ ...entry, liveIds: [...entry.liveIds] }));
  }

  _makeTable(records, level) {
    const sortedRecords = records.map(cloneRecord).sort((a, b) => compareKeys(a.key, b.key));
    if (sortedRecords.length === 0) return null;
    const id = `SST-${String(this.nextTableId).padStart(3, "0")}`;
    this.nextTableId += 1;
    const blocks = [];
    const sparseIndex = [];
    for (let offset = 0; offset < sortedRecords.length; offset += BLOCK_SIZE) {
      const blockIndex = blocks.length;
      const block = sortedRecords.slice(offset, offset + BLOCK_SIZE);
      blocks.push(block);
      sparseIndex.push({ key: block[0].key, blockIndex });
    }
    const minKey = sortedRecords[0].key;
    const maxKey = sortedRecords[sortedRecords.length - 1].key;
    const table = {
      id,
      level,
      minKey,
      maxKey,
      records: sortedRecords,
      blocks,
      sparseIndex,
      bloom: createBloomFilter(sortedRecords),
      footer: {
        magic: "LSM1",
        tableId: id,
        level,
        minKey,
        maxKey,
        recordCount: sortedRecords.length,
        maxSequence: Math.max(...sortedRecords.map((record) => record.seq)),
      },
    };
    this.tables.set(id, table);
    this.counters.physicalSstableRecordsWritten += sortedRecords.length;
    this._emit("SSTABLE_CREATED", { tableId: id, level, minKey, maxKey, recordCount: sortedRecords.length });
    return table;
  }

  _flushMemtable() {
    const records = this.memtable.entries();
    if (records.length === 0) {
      this._emit("FLUSH", { tableId: null, recordCount: 0, checkpoint: this.flushCheckpoint });
      return false;
    }
    const table = this._makeTable(records, 0);
    this.levels[0].push(table.id);
    this.memtable = new SkipList(this.seed);
    this.flushCheckpoint = Math.max(this.flushCheckpoint, ...records.map((record) => record.seq));
    this._publishManifest("flush");
    this._persistLayout();
    this.counters.flushes += 1;
    this._emit("FLUSH", {
      tableId: table.id,
      recordCount: records.length,
      checkpoint: this.flushCheckpoint,
    });
    return true;
  }

  put(key, value) {
    return this._write(key, value, false);
  }

  delete(key) {
    return this._write(key, null, true);
  }

  _write(key, value, tombstone) {
    validateKey(key);
    if (!tombstone && typeof value !== "string") {
      throw new TypeError("Values must be strings.");
    }
    const newDistinctKey = !this.memtable.find(key);
    const record = { key, value, tombstone, seq: this.nextSequence };
    this.nextSequence += 1;
    this.counters[tombstone ? "deletes" : "writes"] += 1;
    this._emit(tombstone ? "DELETE" : "PUT", { record: cloneRecord(record), key });
    this.wal.push(cloneRecord(record));
    this.counters.walRecords += 1;
    this._emit("WAL_APPEND", { record: cloneRecord(record) });
    if (newDistinctKey && this.memtable.size >= this.memtableCapacity) {
      this._emit("MEMTABLE_FULL", { key, count: this.memtable.size, capacity: this.memtableCapacity });
      this._flushMemtable();
    }
    this.memtable.set(record);
    this._emit("MEMTABLE_UPDATE", { record: cloneRecord(record) });
    return cloneRecord(record);
  }

  flush() {
    return this._flushMemtable();
  }

  setStrategy(strategy) {
    if (strategy !== "leveled" && strategy !== "size-tiered") {
      throw new RangeError("Strategy must be 'leveled' or 'size-tiered'.");
    }
    if (this.strategy === strategy) return false;
    this.strategy = strategy;
    this._emit("STRATEGY", { strategy });
    return true;
  }

  _table(id) {
    const table = this.tables.get(id);
    if (!table) throw new Error(`Manifest references missing table ${id}.`);
    return table;
  }

  _findInTable(table, key) {
    if (compareKeys(key, table.minKey) < 0 || compareKeys(key, table.maxKey) > 0) return null;
    if (!bloomMayContain(table.bloom, key)) return null;
    return recordAt(table, key);
  }

  inspectBloom(tableId, key) {
    validateKey(key);
    const table = this._table(tableId);
    const withinRange = compareKeys(key, table.minKey) >= 0 && compareKeys(key, table.maxKey) <= 0;
    const mayContain = withinRange && bloomMayContain(table.bloom, key);
    const record = mayContain ? recordAt(table, key) : null;
    return { tableId, key, withinRange, mayContain, verifiedPresent: Boolean(record), record: record ? cloneRecord(record) : null };
  }

  get(key) {
    validateKey(key);
    this.counters.gets += 1;
    this._emit("GET_CHECK", { key, tableId: "MemTable" });
    const memoryRecord = this.memtable.find(key);
    if (memoryRecord) {
      this._emit(memoryRecord.tombstone ? "NOT_FOUND" : "FOUND", {
        key, source: "MemTable", tombstone: memoryRecord.tombstone, seq: memoryRecord.seq,
        record: cloneRecord(memoryRecord),
      });
      return memoryRecord.tombstone ? null : { ...memoryRecord, source: "MemTable" };
    }

    const candidates = [];
    for (const id of [...this.levels[0]].reverse()) candidates.push(this._table(id));
    for (let level = 1; level < this.levels.length; level += 1) {
      for (const id of this.levels[level]) candidates.push(this._table(id));
    }
    let newestRecord = null;
    let newestSource = null;
    for (const table of candidates) {
      this.counters.sstableChecks += 1;
      this._emit("GET_CHECK", { key, tableId: table.id, level: table.level });
      if (compareKeys(key, table.minKey) < 0 || compareKeys(key, table.maxKey) > 0) {
        this._emit("BLOOM_SKIP", { key, tableId: table.id, reason: "range" });
        continue;
      }
      if (!bloomMayContain(table.bloom, key)) {
        this._emit("BLOOM_SKIP", { key, tableId: table.id, reason: "bloom" });
        continue;
      }
      this.counters.physicalSstableReads += 1;
      const record = recordAt(table, key);
      if (record && (!newestRecord || record.seq > newestRecord.seq)) {
        newestRecord = record;
        newestSource = table.id;
      }
    }
    if (!newestRecord || newestRecord.tombstone) {
      this._emit("NOT_FOUND", { key, source: newestSource, tombstone: Boolean(newestRecord), seq: newestRecord?.seq });
      return null;
    }
    this._emit("FOUND", { key, source: newestSource, tombstone: false, seq: newestRecord.seq, record: cloneRecord(newestRecord) });
    return { ...newestRecord, source: newestSource };
  }

  scan(startKey, endKey) {
    validateKey(startKey);
    validateKey(endKey);
    if (compareKeys(startKey, endKey) > 0) throw new RangeError("Range start must be <= range end.");
    this.counters.scans += 1;
    const winners = new Map();
    const allRecords = [
      ...this.memtable.entries(),
      ...this.levels.flatMap((level) => level.flatMap((id) => this._table(id).records)),
    ];
    for (const record of allRecords) {
      if (compareKeys(record.key, startKey) < 0 || compareKeys(record.key, endKey) > 0) continue;
      const current = winners.get(record.key);
      if (!current || record.seq > current.seq) winners.set(record.key, record);
    }
    const result = [...winners.values()]
      .filter((record) => !record.tombstone)
      .sort((a, b) => compareKeys(a.key, b.key))
      .map(cloneRecord);
    this._emit("RANGE_SCAN", { startKey, endKey, result });
    return result;
  }

  _overlappingDestination(sourceTables, destinationLevel) {
    const destination = this.levels[destinationLevel].map((id) => this._table(id));
    let minKey = sourceTables.reduce((min, table) => compareKeys(table.minKey, min) < 0 ? table.minKey : min, sourceTables[0].minKey);
    let maxKey = sourceTables.reduce((max, table) => compareKeys(table.maxKey, max) > 0 ? table.maxKey : max, sourceTables[0].maxKey);
    const selected = new Set();
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const table of destination) {
        if (selected.has(table.id)) continue;
        if (compareKeys(table.maxKey, minKey) < 0 || compareKeys(table.minKey, maxKey) > 0) continue;
        selected.add(table.id);
        if (compareKeys(table.minKey, minKey) < 0) minKey = table.minKey;
        if (compareKeys(table.maxKey, maxKey) > 0) maxKey = table.maxKey;
        expanded = true;
      }
    }
    return [...selected].map((id) => this._table(id));
  }

  _chooseLeveledCompaction() {
    if (this.levels[0].length >= 2) {
      return { sourceLevel: 0, destinationLevel: 1, sourceIds: [this.levels[0][0]] };
    }
    const capacities = [Infinity, this.memtableCapacity * 10, this.memtableCapacity * 100, Infinity];
    for (let level = 1; level < 3; level += 1) {
      const recordCount = this.levels[level].reduce((sum, id) => sum + this._table(id).records.length, 0);
      if (recordCount > capacities[level] && this.levels[level].length > 0) {
        return { sourceLevel: level, destinationLevel: level + 1, sourceIds: [this.levels[level][0]] };
      }
    }
    return null;
  }

  _chooseTieredCompaction() {
    for (let level = 0; level < 3; level += 1) {
      const tables = this.levels[level].map((id) => this._table(id));
      const bySize = [...tables].sort((a, b) => a.records.length - b.records.length || a.id.localeCompare(b.id));
      for (let start = 0; start <= bySize.length - 3; start += 1) {
        const group = bySize.slice(start, start + 3);
        if (group[2].records.length <= Math.max(1, group[0].records.length) * 2) {
          return {
            sourceLevel: level,
            destinationLevel: level + 1,
            sourceIds: group.map((table) => table.id),
          };
        }
      }
    }
    return null;
  }

  compact() {
    const plan = this.strategy === "leveled"
      ? this._chooseLeveledCompaction()
      : this._chooseTieredCompaction();
    if (!plan) {
      this._emit("COMPACT_SKIPPED", { strategy: this.strategy });
      return false;
    }

    const sourceTables = plan.sourceIds.map((id) => this._table(id));
    const destinationTables = this._overlappingDestination(sourceTables, plan.destinationLevel);
    const inputs = [...sourceTables, ...destinationTables];
    this._emit("COMPACT_START", {
      strategy: this.strategy,
      sourceLevel: plan.sourceLevel,
      destinationLevel: plan.destinationLevel,
      inputIds: inputs.map((table) => table.id),
      fileIds: inputs.map((table) => table.id),
    });
    const selectedIds = new Set(inputs.map((table) => table.id));
    const winnerByKey = new Map();
    for (const table of inputs) {
      for (const record of table.records) {
        const current = winnerByKey.get(record.key);
        if (!current || record.seq > current.seq) winnerByKey.set(record.key, record);
      }
    }

    const remainingRecords = [
      ...this.memtable.entries(),
      ...this.levels.flatMap((level) => level
        .filter((id) => !selectedIds.has(id))
        .flatMap((id) => this._table(id).records)),
    ];
    const outputRecords = [...winnerByKey.values()].filter((record) => {
      if (!record.tombstone || plan.destinationLevel !== 3) return true;
      return remainingRecords.some((remaining) => remaining.key === record.key);
    });
    this._emit("MERGE", {
      inputIds: inputs.map((table) => table.id),
      recordCount: inputs.reduce((sum, table) => sum + table.records.length, 0),
      outputCount: outputRecords.length,
      droppedVersions: inputs.reduce((sum, table) => sum + table.records.length, 0) - winnerByKey.size,
      droppedTombstones: winnerByKey.size - outputRecords.length,
    });

    for (let level = 0; level < this.levels.length; level += 1) {
      this.levels[level] = this.levels[level].filter((id) => !selectedIds.has(id));
    }
    const output = this._makeTable(outputRecords, plan.destinationLevel);
    if (output) this.levels[plan.destinationLevel].push(output.id);
    this._publishManifest("compaction");
    this._persistLayout();
    this.counters.compactions += 1;
    this._emit("COMPACT_END", {
      strategy: this.strategy,
      sourceLevel: plan.sourceLevel,
      destinationLevel: plan.destinationLevel,
      inputIds: inputs.map((table) => table.id),
      outputId: output ? output.id : null,
      droppedTombstones: winnerByKey.size - outputRecords.length,
    });
    return true;
  }

  crashRecover() {
    const previousCheckpoint = this.flushCheckpoint;
    this.levels = this.durableLevels.map((level) => [...level]);
    this.tables = new Map([...this.tables].filter(([id]) => this.durableTableIds.includes(id)));
    this.manifestVersion = this.durableManifestVersion;
    this.manifestHistory = this.durableManifestHistory.map((entry) => ({ ...entry, liveIds: [...entry.liveIds] }));
    this.memtable = new SkipList(this.seed);
    this.recoveryCount += 1;
    this._emit("CRASH", { checkpoint: previousCheckpoint });

    const replay = this.wal.filter((record) => record.seq > previousCheckpoint);
    this._emit("REPLAY", { phase: "start", replayCount: replay.length, checkpoint: previousCheckpoint });
    for (const record of replay) {
      if (!this.memtable.find(record.key) && this.memtable.size >= this.memtableCapacity) {
        this._flushMemtable();
      }
      this.memtable.set(record);
      this.counters.replays += 1;
      this._emit("REPLAY", { record: cloneRecord(record), phase: "record" });
    }
    this._emit("REPLAY", { phase: "complete", replayed: replay.length, recoveryCount: this.recoveryCount });
    return { replayed: replay.length, checkpoint: this.flushCheckpoint };
  }

  snapshot() {
    const tableViews = {};
    for (const [id, table] of this.tables) {
      tableViews[id] = {
        id: table.id,
        level: table.level,
        minKey: table.minKey,
        maxKey: table.maxKey,
        records: table.records.map(cloneRecord),
        blocks: table.blocks.map((block) => block.map(cloneRecord)),
        sparseIndex: table.sparseIndex.map((entry) => ({ ...entry })),
        bloom: { bits: [...table.bloom.bits], hashCount: table.bloom.hashCount },
        footer: { ...table.footer },
      };
    }
    return {
      strategy: this.strategy,
      memtableCapacity: this.memtableCapacity,
      memtable: this.memtable.entries(),
      wal: this.wal.map(cloneRecord),
      nextSequence: this.nextSequence,
      levels: this.levels.map((level) => [...level]),
      tables: tableViews,
      manifest: {
        version: this.manifestVersion,
        liveIds: this.levels.flat(),
        history: this.manifestHistory.map((entry) => ({ ...entry, liveIds: [...entry.liveIds] })),
      },
      skipList: this.memtable.structure(),
      counters: { ...this.counters },
      visualization: structuredClone(this.visualization),
      flushCheckpoint: this.flushCheckpoint,
      durableLevels: this.durableLevels.map((level) => [...level]),
      durableTableIds: [...this.durableTableIds],
      durableManifestVersion: this.durableManifestVersion,
      durableManifestHistory: this.durableManifestHistory.map((entry) => ({ ...entry, liveIds: [...entry.liveIds] })),
      recoveryCount: this.recoveryCount,
      nextTableId: this.nextTableId,
      caption: this.currentCaption,
      visualizationHighlights: structuredClone(this.visualization),
      physicalTableIds: [...this.tables.keys()],
    };
  }

  restore(state) {
    this.strategy = state.strategy;
    this.wal = state.wal.map(cloneRecord);
    this.nextSequence = state.nextSequence;
    this.nextTableId = state.nextTableId;
    this.memtable.restore(state.skipList);
    this.levels = state.levels.map((level) => [...level]);
    this.tables = new Map(Object.entries(state.tables).map(([id, table]) => [id, structuredClone(table)]));
    this.manifestVersion = state.manifest.version;
    this.manifestHistory = state.manifest.history.map((entry) => ({ ...entry, liveIds: [...entry.liveIds] }));
    this.flushCheckpoint = state.flushCheckpoint;
    this.durableLevels = state.durableLevels.map((level) => [...level]);
    this.durableTableIds = [...state.durableTableIds];
    this.durableManifestVersion = state.durableManifestVersion;
    this.durableManifestHistory = state.durableManifestHistory.map((entry) => ({ ...entry, liveIds: [...entry.liveIds] }));
    this.recoveryCount = state.recoveryCount;
    this.counters = { ...state.counters };
    this.visualization = structuredClone(state.visualization);
    this.currentCaption = state.caption;
  }
}
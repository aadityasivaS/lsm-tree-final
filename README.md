# LSM Tree Visualizer

A browser-based, interactive Log-Structured Merge Tree (LSM tree) simulator for a DBMS course project and systems-learning portfolio. It demonstrates how writes travel through a write-ahead log (WAL) and sorted in-memory skip list, how immutable sorted-string tables (SSTables) are flushed and compacted, and how reads resolve multiple versions and delete tombstones.

The project is educational, not a production database. All state is simulated in browser memory, with no backend, database, package dependencies, external libraries, CDN assets, network API, or persistence across page reloads.

## Learning Goals

- Trace a logical write from its operation event through WAL append and MemTable update.
- Observe capacity-triggered flushes, immutable SSTable metadata, and manifest changes.
- Compare leveled and size-tiered compaction using actual engine state.
- Understand sequence-number version resolution, Bloom-filter behavior, tombstones, and WAL recovery.
- Step through immutable snapshots, branch from an earlier event, and inspect the effect of each operation.

## Features and Operations

- `PUT`, overwrite, and `DELETE` write operations with monotonic sequence numbers.
- `GET` and inclusive sorted range scan with newest-version resolution.
- A deterministic seeded skip-list MemTable with capacity for four distinct keys; overwrites do not use another slot.
- Append-only simulated WAL and capacity-triggered MemTable flush to L0.
- Immutable SSTables with sorted records, data blocks of up to four records, sparse index, Bloom bit array, key range, and footer.
- Point lookup through MemTable, newest L0 tables, then deeper levels, with key-range and Bloom skips. A Bloom positive is verified against actual records.
- Leveled compaction and size-tiered compaction across L0–L3, with version resolution, tombstones, obsolete table inspection, and versioned manifest history.
- Crash simulation restores the durable layout and replays WAL records beyond the persisted flush checkpoint. Repeated recovery is supported.
- Captioned event snapshots with Prev/Next, Play/Pause, speed control, event selection, history branching, and Reset.
- Deterministic 20-record batch insertion, light/dark theme toggle, responsive layout, and reduced-motion support.
- Isolated browser self-test panel and a command-line test runner.

## Architecture

Engine data structures and algorithms are separate from playback coordination and rendering:

| File | Responsibility |
| --- | --- |
| `js/lsm-engine.js` | Skip list, WAL, SSTables, point/range reads, compaction, manifest, crash recovery, counters, snapshots |
| `js/step-engine.js` | Ordered captioned events, immutable history, exact state restoration, playback, branch truncation, reset |
| `js/app.js` | Dashboard rendering, form/control handlers, metrics, theme and test result UI |
| `js/self-tests.js` | Isolated engine and history tests shared by browser and Node runners |
| `tests/run-self-tests.mjs` | Dependency-free command-line test entry point |
| `index.html` | Accessible page structure and control labels |
| `css/styles.css` | Light/dark themes, responsive layout, event highlights, reduced-motion rules |
| `package.json` | ES module declaration and `npm test` script; no runtime or development dependencies |

## Run Locally

Requirements: a modern browser, Node.js for command-line tests, and Python 3 (or another static file server) to serve ES modules over HTTP.

From the project directory:

```sh
python3 -m http.server 8000
```

Open <http://localhost:8000>. The static server only serves project files. No build or install step is needed to run the visualizer.

## Run Tests

Run the same 18 isolated tests from the terminal:

```sh
npm test
```

The command uses only Node.js built-ins and adds no dependencies. The dashboard's **Run 18 tests** control runs them in fresh engine instances and does not mutate the visible demonstration. Coverage includes L3 tombstone removal followed by crash recovery, physical-write accounting, and rejected-action history preservation. JavaScript syntax can also be checked directly:

```sh
node --check js/lsm-engine.js
node --check js/step-engine.js
node --check js/app.js
node --check js/self-tests.js
node --check tests/run-self-tests.mjs
```

## LSM Tree Concepts in This Model

### Write Path and WAL

Each accepted PUT or DELETE receives a monotonically increasing sequence number and is appended to the in-memory WAL. The operation updates the skip-list MemTable. Overwriting an existing MemTable key changes its current entry without increasing its distinct-key occupancy. Before a fifth distinct key is inserted, the full four-key MemTable is flushed.

### Flush and SSTables

Flush sorts the MemTable records into an immutable level-0 SSTable. Each table contains records, blocks, one sparse-index entry per block, a Bloom filter, minimum and maximum keys, and a footer. Flush advances a simulated durable checkpoint and updates the live-file manifest. The SSTable is immutable; later changes create new records and files.

### Reads, Versions, and Tombstones

A point GET checks the MemTable and then sorted tables. A range check or Bloom negative can skip a table; a Bloom positive means only “possibly present” and still requires a record lookup. Matching versions are resolved by their sequence numbers. DELETE writes a tombstone rather than removing old storage records immediately. A winning tombstone hides older values until compaction can safely discard it.

Range scans use inclusive string-key boundaries, resolve the highest-sequence record per key, remove keys whose winning record is a tombstone, and return the remaining keys in sorted order.

### Compaction Strategies

- **Leveled:** L0 becomes eligible at two files. A deterministic source is selected and all overlapping destination files are included. L1 and L2 use approximate record capacities of 10× and 100× the four-key MemTable capacity; L3 is the final level.
- **Size-tiered:** three eligible, similarly sized SSTables are selected for a merge into the next tier. Overlapping destination files are included where required to preserve deeper-level range invariants.

Both strategies merge immutable input records, retain the newest version for each key, create replacement SSTables, and publish a new manifest version. Obsolete tables remain available for history/inspection but are excluded from live levels. Tombstones are dropped at L3 only when no remaining source can expose an older value.

### Crash Recovery

The durable layout consists of the committed live tables, manifest history, and the highest sequence represented by a flush checkpoint. Simulated crash discards volatile MemTable state, restores that layout, and replays WAL records newer than the checkpoint. The WAL is not appended a second time during replay. This separation is educational simulation only; neither WAL nor SSTables are written to disk.

## Dashboard Metrics

The dashboard distinguishes logical requests from simulated physical record work. These are record-count estimates, not byte-accurate or benchmark-grade measurements:

- **Write amplification** = cumulative SSTable records created by flush and compaction ÷ logical PUT and DELETE operations.
- **Read amplification** = SSTable range/Bloom checks ÷ logical GET operations. This measures filter/table probes, not disk I/O or MemTable comparisons.
- **Space amplification** = records retained across all known SSTables, including obsolete files ÷ distinct non-tombstoned keys represented in live SSTables. MemTable-only keys are excluded from the denominator.
- The statistics also show logical PUTs, DELETEs, GETs, range scans, flushes, compactions, files per level, MemTable occupancy, WAL record count, live SSTable record count, and cumulative physical SSTable record writes.
- When both numerator and denominator are zero the ratio displays `n/a`; a nonzero numerator over a zero denominator displays infinity.

## Demo Walkthrough

1. PUT four distinct keys and inspect the WAL and skip-list lanes.
2. PUT a fifth distinct key. Observe `MEMTABLE_FULL`, SSTable creation, manifest update, and the new key entering the empty MemTable.
3. Overwrite a key, flush, and GET it to see the newest sequence win.
4. DELETE that key, then run GET and an inclusive range scan to verify tombstone filtering.
5. Flush enough runs to make compaction eligible. Toggle between Leveled and Size-tiered and compare the new level layout and manifest.
6. Select an SSTable card to inspect records, active/obsolete/tombstone states, blocks, sparse index, Bloom bits, and footer.
7. Leave writes unflushed and simulate a crash. Inspect checkpoint and replay events, then repeat recovery.
8. Use Prev/Next or select a row in the event log. Branch with a new operation, then Reset to clear state and counters.
9. Insert the reproducible 20-key batch and run the isolated tests.

## DBMS Viva Questions

**Why are LSM trees useful for write-heavy workloads?** Writes are buffered and converted into sequential sorted runs, reducing the cost of random in-place updates at the expense of read and compaction work.

**What does the WAL provide?** It records accepted operations so volatile MemTable state can be rebuilt after a crash. The flush checkpoint excludes operations already represented by durable tables.

**Why are sequence numbers needed?** A key may have multiple versions across the MemTable and SSTables. The highest sequence number identifies the latest PUT or DELETE.

**Why use tombstones?** An old value may remain in immutable files. A tombstone masks it until compaction can safely remove the older value and, at the bottom level, the tombstone itself.

**What does a Bloom filter guarantee?** A negative indicates absence from the filter's table; a positive may be a false positive and must be checked against actual records.

**How do leveled and size-tiered compaction differ?** Leveled compaction controls overlap and keeps bounded levels; size-tiered compaction groups similarly sized runs before merging. They trade write amplification, read amplification, and space differently.

**What is the durability guarantee here?** There is no real disk durability. The browser simulates separate volatile and durable states so checkpoint/replay behavior can be demonstrated.

## Technologies and Limitations

- Vanilla HTML, CSS, and JavaScript ES modules; Node.js built-ins are used for command-line testing only.
- No backend, database, external dependency, CDN, network request, browser storage, or local file persistence.
- Data resets on page reload. Keys use JavaScript string ordering. SSTable blocks and amplification metrics are educational record-count abstractions.
- Compaction scheduling is manually triggered from the UI; this project does not implement concurrent writes, background compaction, disk pages, checksums, or production-grade crash durability.

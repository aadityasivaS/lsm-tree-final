import { StepEngine } from "./step-engine.js";
import { runSelfTests } from "./self-tests.js";
import { createTutorial } from "./tutorial.js";

const stepper = new StepEngine({ memtableCapacity: 4, seed: 2026 });
const $ = (selector) => document.querySelector(selector);
const elements = {
  notice: $("#notice"),
  strategy: $("#strategy-control"),
  status: $("#status-strip"),
  memtableCount: $("#memtable-count"),
  memtable: $("#memtable-view"),
  levels: $("#levels-view"),
  inspector: $("#table-inspector"),
  walCount: $("#wal-count"),
  wal: $("#wal-view"),
  manifestVersion: $("#manifest-version"),
  manifest: $("#manifest-view"),
  queryResult: $("#query-result"),
  eventTitle: $("#event-title"),
  eventCaption: $("#event-caption"),
  eventCount: $("#event-count"),
  historyRange: $("#history-range"),
  eventTicks: $("#event-ticks"),
  eventLog: $("#event-log"),
  stepBack: $("#step-back"),
  stepForward: $("#step-forward"),
  play: $("#play-button"),
  reset: $("#reset-button"),
  speed: $("#speed-range"),
  speedValue: $("#speed-value"),
  statistics: $("#statistics-view"),
  amplification: $("#amplification-view"),
  selfTestButton: $("#run-self-tests"),
  selfTestSummary: $("#self-test-summary"),
  selfTestResults: $("#self-test-results"),
  theme: $("#theme-toggle"),
};

let inspectedTableId = null;
let noticeTimer = null;
let batchSeed = 20261024;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function showNotice(message, isError = false) {
  clearTimeout(noticeTimer);
  elements.notice.textContent = message;
  elements.notice.classList.toggle("notice-error", isError);
  elements.notice.hidden = false;
  noticeTimer = setTimeout(() => { elements.notice.hidden = true; }, 3500);
}

function eventTitle(event) {
  const key = event.key || event.record?.key;
  switch (event.type) {
    case "initial": return "Ready";
    case "PUT": return `PUT · ${key}`;
    case "DELETE": return `DELETE · ${key}`;
    case "WAL_APPEND": return `WAL append · #${event.record.seq}`;
    case "MEMTABLE_FULL": return "MemTable full";
    case "MEMTABLE_UPDATE": return `MemTable update · ${key}`;
    case "SSTABLE_CREATED": return `${event.tableId} created · L${event.level}`;
    case "FLUSH": return event.tableId ? `Flush · ${event.tableId}` : "Flush skipped";
    case "MANIFEST_UPDATE": return `Manifest v${event.version}`;
    case "COMPACT_START": return `Compaction · L${event.sourceLevel} → L${event.destinationLevel}`;
    case "MERGE": return "Merge records";
    case "COMPACT_END": return "Compaction committed";
    case "COMPACT_SKIPPED": return "No compaction eligible";
    case "GET_CHECK": return `GET check · ${event.tableId}`;
    case "BLOOM_SKIP": return `Lookup skip · ${event.tableId}`;
    case "FOUND": return `Found · ${key}`;
    case "NOT_FOUND": return `Not found · ${key}`;
    case "RANGE_SCAN": return `Range · ${event.startKey}–${event.endKey}`;
    case "CRASH": return "Crash simulated";
    case "REPLAY": return event.phase === "start" ? `Recovery · ${event.replayCount} WAL records` : event.phase === "complete" ? "Recovery complete" : `WAL replay · #${event.record?.seq}`;
    case "STRATEGY": return `Strategy · ${event.strategy}`;
    default: return event.type.replaceAll("_", " ").toLowerCase();
  }
}

function recordStatus(record, activeVersions) {
  if (record.tombstone) return "tombstone";
  return activeVersions.get(record.key)?.seq === record.seq ? "active" : "obsolete";
}

function recordChip(record, activeVersions) {
  const status = recordStatus(record, activeVersions);
  const text = record.tombstone ? "DELETE" : record.value;
  return `<span class="record-chip ${status}" title="${status} version, sequence ${record.seq}"><strong>${escapeHtml(record.key)}</strong><span>${escapeHtml(text)}</span><span class="chip-seq">#${record.seq}</span><span class="record-status">${status}</span></span>`;
}

function activeVersions(state) {
  const winners = new Map();
  const records = [
    ...state.memtable,
    ...state.levels.flatMap((level) => level.flatMap((id) => state.tables[id]?.records || [])),
  ];
  for (const record of records) {
    if (!winners.has(record.key) || winners.get(record.key).seq < record.seq) winners.set(record.key, record);
  }
  return winners;
}

function renderStatus(state) {
  const liveTables = state.levels.flat();
  const values = [
    ["WAL NEXT SEQUENCE", `#${state.nextSequence}`],
    ["FLUSH CHECKPOINT", `#${state.flushCheckpoint}`],
    ["LIVE SSTABLES", String(liveTables.length)],
    ["ACTIVE STRATEGY", state.strategy.toUpperCase()],
  ];
  elements.status.innerHTML = values.map(([label, value], index) => `
    <div class="metric"><span class="metric-label">${label}</span><span class="metric-value${index === 3 ? " accent" : ""}">${escapeHtml(value)}</span></div>
  `).join("");
}

function renderMemtable(state, event) {
  const active = activeVersions(state);
  elements.memtableCount.textContent = `${state.memtable.length} / ${state.memtableCapacity} KEYS`;
  if (state.memtable.length) {
    const lanes = [];
    for (let level = state.skipList.level; level >= 0; level -= 1) {
      const nodes = state.skipList.nodes.filter((node) => node.level >= level);
      lanes.push(`<div class="skip-lane"><span class="skip-lane-label">L${level}</span><div class="skip-lane-track">${nodes.map((node, index) => `<span class="skip-node">${escapeHtml(node.record.key)}${index < nodes.length - 1 ? '<i aria-hidden="true">→</i>' : ""}</span>`).join("")}</div></div>`);
    }
    elements.memtable.innerHTML = `<div class="skip-topology" aria-label="Skip-list tower structure">${lanes.join("")}</div><div class="memtable-records">${state.memtable.map((record) => recordChip(record, active)).join("")}</div>`;
  } else {
    elements.memtable.innerHTML = '<span class="empty-hint">Empty · new writes land here after the WAL.</span>';
  }
  elements.memtable.classList.toggle("is-inserting", event?.type === "MEMTABLE_UPDATE");
  elements.memtable.classList.toggle("lookup-path", event?.type === "GET_CHECK" && event.tableId === "MemTable");
}

function tableCard(id, state, active, event) {
  const table = state.tables[id];
  if (!table) return "";
  const live = state.levels.flat().includes(id);
  const inputIds = event?.inputIds || event?.fileIds || [];
  const compacting = ["COMPACT_START", "MERGE"].includes(event?.type) && inputIds.includes(id);
  const skipped = event?.type === "BLOOM_SKIP" && event.tableId === id;
  const checking = event?.type === "GET_CHECK" && event.tableId === id;
  const incoming = event?.type === "COMPACT_END" && event.outputId === id;
  const flushed = event?.type === "FLUSH" && event.tableId === id;
  const created = event?.type === "SSTABLE_CREATED" && event.tableId === id;
  const pressed = inspectedTableId === id ? "true" : "false";
  const obsoleteCount = table.records.filter((record) => recordStatus(record, active) === "obsolete").length;
  const tombstoneCount = table.records.filter((record) => record.tombstone).length;
  const classes = ["sstable", !live && !created ? "obsolete-file" : "", compacting ? "compacting" : "", skipped ? "lookup-skipped" : "", checking ? "lookup-check" : "", incoming || flushed || created ? "just-created" : ""].filter(Boolean).join(" ");
  const stateText = compacting ? "COMPACTING" : skipped ? "LOOKUP SKIPPED" : created ? "CREATED" : live ? "LIVE" : "OBSOLETE";
  return `<button type="button" class="${classes}" data-table-id="${escapeHtml(id)}" aria-pressed="${pressed}" aria-label="Inspect ${escapeHtml(id)} at level ${table.level}, ${stateText.toLowerCase()}">
    <span class="sstable-top"><strong>${escapeHtml(id)}</strong><span>${stateText}</span></span>
    <span class="sstable-range">L${table.level} · ${escapeHtml(table.minKey)} <span aria-hidden="true">↔</span> ${escapeHtml(table.maxKey)}</span>
    <span class="sstable-bottom"><span>${table.records.length} records · max #${table.footer.maxSequence}</span><span>${obsoleteCount ? `${obsoleteCount} old` : ""}${tombstoneCount ? ` ${tombstoneCount} del` : ""}</span></span>
  </button>`;
}

function renderLevels(state, event) {
  const active = activeVersions(state);
  const descriptions = ["RECENT · MAY OVERLAP", "10× CAPACITY", "100× CAPACITY", "FINAL LEVEL"];
  const liveIds = new Set(state.levels.flat());
  elements.levels.innerHTML = state.levels.map((ids, level) => {
    const cards = ids.map((id) => tableCard(id, state, active, event)).join("");
    const flushing = event?.type === "FLUSH" && ids.includes(event.tableId);
    return `<div class="level-row${flushing ? " is-flushing" : ""}" data-level="${level}"><div class="level-label"><strong>L${level}</strong><span>${descriptions[level]}</span></div><div class="level-content">${cards || '<span class="empty-hint">No files in this level.</span>'}</div></div>`;
  }).join("");

  const obsoleteIds = Object.keys(state.tables).filter((id) => !liveIds.has(id));
  if (obsoleteIds.length) {
    elements.levels.insertAdjacentHTML("beforeend", `<div class="obsolete-shelf"><div class="obsolete-label">OBSOLETE FILES <span>retained for history</span></div><div class="level-content">${obsoleteIds.map((id) => tableCard(id, state, active, event)).join("")}</div></div>`);
  }
  if (!state.tables[inspectedTableId]) inspectedTableId = null;
  renderInspector(state, active);
}

function renderInspector(state, active) {
  const table = inspectedTableId ? state.tables[inspectedTableId] : null;
  if (!table) {
    elements.inspector.innerHTML = "";
    return;
  }
  const records = table.records.map((record) => {
    const status = recordStatus(record, active);
    return `${escapeHtml(record.key)}=${record.tombstone ? "&lt;tombstone&gt;" : escapeHtml(record.value)} #${record.seq} [${status}]`;
  }).join("<br>");
  const blockText = table.blocks.map((block, index) => `B${index}[${block.map((record) => record.key).join(", ")}]`).join(" · ");
  const indexText = table.sparseIndex.map((entry) => `${entry.key}→B${entry.blockIndex}`).join(" · ");
  const bitSample = table.bloom.bits.map((bit) => `<i class="${bit ? "on" : ""}"></i>`).join("");
  const live = state.levels.flat().includes(table.id);
  elements.inspector.innerHTML = `
    <div><div class="section-kicker">SSTABLE INSPECTOR · ${live ? "LIVE" : "OBSOLETE"}</div><div class="inspector-title">${escapeHtml(table.id)}</div><div class="inspector-subtitle">Level ${table.level} · range ${escapeHtml(table.minKey)}–${escapeHtml(table.maxKey)}</div></div>
    <div class="inspector-block"><h3>RECORDS · SEQUENCE RESOLUTION</h3><div class="inspector-data">${records}</div><h3 class="inspector-subheading">BLOCKS · SPARSE INDEX</h3><div class="inspector-data">${escapeHtml(blockText)}<br>INDEX ${escapeHtml(indexText)}</div></div>
    <div class="inspector-block"><h3>BLOOM FILTER · ${table.bloom.hashCount} HASHES · ${table.bloom.bits.length} BITS</h3><div class="inspector-data">A POSITIVE IS ONLY A POSSIBLE MATCH.</div><div class="bloom-bits" aria-label="Bloom filter bits">${bitSample}</div><h3 class="inspector-subheading">FOOTER</h3><div class="inspector-data">${escapeHtml(JSON.stringify(table.footer))}</div></div>
  `;
}

function renderWal(state, event) {
  elements.walCount.textContent = `${state.wal.length} RECORD${state.wal.length === 1 ? "" : "S"}`;
  elements.wal.innerHTML = state.wal.length ? state.wal.map((record) => `
    <div class="wal-row${record.tombstone ? " delete" : ""}" data-seq="${record.seq}">
      <span class="wal-seq${record.seq <= state.flushCheckpoint ? " wal-checkpoint" : ""}">#${record.seq}</span>
      <span class="wal-op">${record.tombstone ? "DELETE" : "PUT"}</span>
      <span class="wal-key">${escapeHtml(record.key)}</span>
      <span class="wal-value">${record.tombstone ? "tombstone" : escapeHtml(record.value)}</span>
    </div>`).join("") : '<span class="empty-hint">No WAL records yet.</span>';
  const activeSequence = event?.record?.seq;
  if (activeSequence) elements.wal.querySelector(`[data-seq="${activeSequence}"]`)?.classList.add("event-active");
}

function renderManifest(state) {
  elements.manifestVersion.textContent = `V${state.manifest.version}`;
  const liveIds = state.manifest.liveIds;
  const history = state.manifest.history.slice().reverse();
  elements.manifest.innerHTML = `
    <div class="manifest-summary"><span>${liveIds.length} LIVE FILES</span><span>CHECKPOINT #${state.flushCheckpoint}</span></div>
    <div class="manifest-ids">${liveIds.length ? liveIds.map((id) => `<span class="manifest-id">${escapeHtml(id)}</span>`).join("") : '<span class="empty-hint">No durable tables.</span>'}</div>
    <div class="manifest-history">${history.length ? history.map((entry) => `<div><span>v${entry.version} · ${escapeHtml(entry.reason)}</span><span>${entry.liveIds.length} files</span></div>`).join("") : "Manifest has no committed changes."}</div>
  `;
}

function renderStatistics(state) {
  const liveTableIds = state.levels.flat();
  const liveSstableRecords = liveTableIds.reduce((count, id) => count + (state.tables[id]?.records.length || 0), 0);
  const allRetainedRecords = Object.values(state.tables).reduce((count, table) => count + table.records.length, 0);
  const onDiskWinners = activeVersions({ ...state, memtable: [] });
  const logicalLiveSstableRecords = [...onDiskWinners.values()].filter((record) => !record.tombstone).length;
  const filesPerLevel = state.levels.map((ids, level) => `L${level} ${ids.length}`).join(" · ");
  const metrics = [
    ["LOGICAL PUTS", state.counters.writes], ["LOGICAL DELETES", state.counters.deletes],
    ["LOGICAL GETS", state.counters.gets], ["RANGE SCANS", state.counters.scans],
    ["FLUSHES", state.counters.flushes], ["COMPACTIONS", state.counters.compactions],
    ["FILES / LEVEL", filesPerLevel], ["MEMTABLE", `${state.memtable.length}/${state.memtableCapacity}`],
    ["WAL RECORDS", state.wal.length], ["LIVE SST RECORDS", liveSstableRecords],
    ["PHYSICAL SST WRITES", state.counters.physicalSstableRecordsWritten],
  ];
  elements.statistics.innerHTML = metrics.map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`).join("");

  const ratio = (numerator, denominator) => denominator === 0
    ? (numerator === 0 ? "n/a" : "∞")
    : `${(numerator / denominator).toFixed(2)}×`;
  const logicalWrites = state.counters.writes + state.counters.deletes;
  const amplification = [
    ["WRITE AMPLIFICATION", ratio(state.counters.physicalSstableRecordsWritten, logicalWrites)],
    ["READ AMPLIFICATION", ratio(state.counters.sstableChecks, state.counters.gets)],
    ["SPACE AMPLIFICATION", ratio(allRetainedRecords, logicalLiveSstableRecords)],
  ];
  elements.amplification.innerHTML = amplification.map(([label, value]) => `<div class="amplification-metric"><span>${label}</span><strong>${value}</strong></div>`).join("");
}

function renderSelfTests(results) {
  const passed = results.filter((result) => result.status === "PASS").length;
  const failed = results.length - passed;
  elements.selfTestSummary.textContent = `${passed} passed · ${failed} failed · ${results.length} checks`;
  elements.selfTestSummary.className = `self-test-summary ${failed ? "has-failures" : "all-passed"}`;
  elements.selfTestResults.innerHTML = results.map((result) => `<li class="test-result ${result.status.toLowerCase()}"><span class="test-status">${result.status}</span><strong>${escapeHtml(result.name)}</strong><span class="test-reason">${escapeHtml(result.reason)}</span></li>`).join("");
}

function renderStrategy(state) {
  for (const button of elements.strategy.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.strategy === state.strategy));
  }
}

function renderTimeline(current) {
  const entries = stepper.entries();
  const total = entries.length;
  const lastIndex = total - 1;
  elements.historyRange.max = String(lastIndex);
  elements.historyRange.value = String(current.index);
  elements.eventCount.textContent = `${current.index + 1} / ${total}`;
  elements.eventTitle.textContent = eventTitle(current.event);
  elements.eventCaption.textContent = current.caption;
  elements.stepBack.disabled = current.index === 0;
  elements.stepForward.disabled = current.index === lastIndex;
  elements.play.disabled = total <= 1;
  elements.play.textContent = stepper.isPlaying() ? "Ⅱ" : "▶";
  elements.play.setAttribute("aria-label", stepper.isPlaying() ? "Pause event history" : "Play event history");

  const recent = entries.slice(Math.max(0, current.index - 4), current.index + 5);
  elements.eventTicks.innerHTML = recent.map((entry) => `<button type="button" class="event-tick${entry.index === current.index ? " current" : ""}" data-history-index="${entry.index}" title="${escapeHtml(entry.caption)}" ${entry.index === current.index ? 'aria-current="step"' : ""}>${entry.index + 1} · ${escapeHtml(entry.event.type)}</button>`).join("");
  elements.eventLog.innerHTML = entries.map((entry) => `<button type="button" class="log-entry${entry.index === current.index ? " current" : ""}" data-history-index="${entry.index}" aria-current="${entry.index === current.index ? "step" : "false"}"><span class="log-step">${String(entry.index + 1).padStart(2, "0")}</span><span class="log-type">${escapeHtml(entry.event.type)}</span><span class="log-caption">${escapeHtml(entry.caption)}</span></button>`).join("");
  const selectedLog = elements.eventLog.querySelector(".log-entry.current");
  if (selectedLog) elements.eventLog.scrollTop = selectedLog.offsetTop - elements.eventLog.offsetTop;
}

function renderQueryResult(event) {
  if (event.type === "FOUND") {
    const record = event.record;
    elements.queryResult.innerHTML = `<span class="result-label">GET · ${escapeHtml(event.key)}</span><p class="result-record">${escapeHtml(record.value)} · seq #${record.seq} · ${escapeHtml(event.source)}</p>`;
  } else if (event.type === "NOT_FOUND") {
    elements.queryResult.innerHTML = `<span class="result-label">GET · ${escapeHtml(event.key)}</span><p class="result-record">Not found or deleted.</p>`;
  } else if (event.type === "RANGE_SCAN") {
    const body = event.result.length
      ? event.result.map((record) => `${escapeHtml(record.key)}=${escapeHtml(record.value)} <span>#${record.seq}</span>`).join(" · ")
      : "No live keys in this range.";
    elements.queryResult.innerHTML = `<span class="result-label">INCLUSIVE SCAN · ${escapeHtml(event.startKey)}–${escapeHtml(event.endKey)}</span><p class="result-record">${body}</p>`;
  } else {
    elements.queryResult.innerHTML = '<span class="result-label">QUERY RESULT</span><p>Read or scan to inspect resolved records.</p>';
  }
}

function render(current = stepper.current()) {
  const state = current.state;
  const event = current.event;
  renderStatus(state);
  renderMemtable(state, event);
  renderLevels(state, event);
  renderWal(state, event);
  renderManifest(state);
  renderStatistics(state);
  renderStrategy(state);
  renderTimeline(current);
  const lastQuery = stepper.entries().slice(0, current.index + 1).reverse()
    .find((entry) => ["FOUND", "NOT_FOUND", "RANGE_SCAN"].includes(entry.event.type));
  renderQueryResult(lastQuery?.event || event);
}

function runAction(action) {
  try {
    const result = stepper.execute(action);
    if (action.type === "flush") showNotice(result ? "MemTable flushed to a durable L0 SSTable." : "MemTable is empty; nothing to flush.");
    if (action.type === "compact") showNotice(result ? "Compaction committed to the manifest." : "No files currently meet this strategy's compaction rules.");
    if (action.type === "crash-recover") showNotice(`Recovery complete. Replayed ${result.replayed} WAL record${result.replayed === 1 ? "" : "s"} after checkpoint #${result.checkpoint}.`);
    return result;
  } catch (error) {
    showNotice(error.message, true);
    return null;
  }
}

$("#write-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const result = runAction({ type: "put", key: String(data.get("key")).trim(), value: String(data.get("value")) });
  if (result) event.currentTarget.reset();
});

$("#delete-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const result = runAction({ type: "delete", key: String(data.get("key")).trim() });
  if (result) event.currentTarget.reset();
});

$("#get-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const key = String(new FormData(event.currentTarget).get("key")).trim();
  const result = runAction({ type: "get", key });
  if (!result) renderQueryResult(stepper.current().event);
});

$("#scan-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const startKey = String(data.get("startKey")).trim();
  const endKey = String(data.get("endKey")).trim();
  const result = runAction({ type: "scan", startKey, endKey });
  if (!Array.isArray(result)) return;
  renderQueryResult(stepper.current().event);
});

elements.strategy.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-strategy]");
  if (button) runAction({ type: "strategy", strategy: button.dataset.strategy });
});

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => runAction({ type: button.dataset.action }));
});

$("#random-batch").addEventListener("click", () => {
  const result = runAction({ type: "random-batch", seed: batchSeed });
  if (result) {
    showNotice(`Inserted ${result.length} reproducible keys through the normal WAL and MemTable path.`);
    batchSeed += 1;
  }
});

elements.levels.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-table-id]");
  if (!button) return;
  inspectedTableId = inspectedTableId === button.dataset.tableId ? null : button.dataset.tableId;
  render();
});

const selectHistory = (index) => {
  stepper.pause();
  stepper.select(index);
};
elements.stepBack.addEventListener("click", () => selectHistory(stepper.current().index - 1));
elements.stepForward.addEventListener("click", () => selectHistory(stepper.current().index + 1));
elements.play.addEventListener("click", () => {
  if (stepper.isPlaying()) stepper.pause();
  else stepper.play(Number(elements.speed.value));
  render();
});
elements.reset.addEventListener("click", () => {
  batchSeed = 20261024;
  inspectedTableId = null;
  elements.queryResult.innerHTML = '<span class="result-label">QUERY RESULT</span><p>Read or scan to inspect resolved records.</p>';
  stepper.reset();
});
elements.selfTestButton.addEventListener("click", async () => {
  elements.selfTestButton.disabled = true;
  elements.selfTestSummary.textContent = "Running isolated engine tests…";
  try {
    renderSelfTests(await runSelfTests());
  } finally {
    elements.selfTestButton.disabled = false;
  }
});
elements.historyRange.addEventListener("input", (event) => selectHistory(Number(event.target.value)));
elements.eventLog.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-history-index]");
  if (button) selectHistory(Number(button.dataset.historyIndex));
});
elements.eventTicks.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-history-index]");
  if (button) selectHistory(Number(button.dataset.historyIndex));
});
elements.speed.addEventListener("input", () => {
  elements.speedValue.textContent = `${elements.speed.value} ms`;
  if (stepper.isPlaying()) {
    stepper.pause();
    stepper.play(Number(elements.speed.value));
  }
});
elements.theme.addEventListener("click", () => {
  const isDark = document.body.classList.toggle("dark-theme");
  elements.theme.setAttribute("aria-label", isDark ? "Enable light theme" : "Enable dark theme");
  document.querySelector('meta[name="theme-color"]').content = isDark ? "#202a25" : "#f3f1e9";
});

stepper.subscribe((current) => render(current));
render();
createTutorial({
  execute: (action) => stepper.execute(action),
  reset: () => {
    batchSeed = 20261024;
    inspectedTableId = null;
    elements.queryResult.innerHTML = '<span class="result-label">QUERY RESULT</span><p>Read or scan to inspect resolved records.</p>';
    stepper.reset();
  },
});
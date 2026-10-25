const TUTORIAL_STORAGE_KEY = "lsm-tree-visualizer-tutorial-complete";

const steps = [
  {
    title: "Welcome to the LSM Tree",
    body: "This short example follows two writes from the write-ahead log into the MemTable, then makes them durable and reads one back.",
    target: "#top",
    action: null,
  },
  {
    title: "1. Write to the WAL and MemTable",
    body: "A PUT is first appended to the write-ahead log, then added to the in-memory sorted buffer. Watch both panels update.",
    target: "#memtable-view",
    action: { type: "put", key: "user:42", value: "Ada" },
  },
  {
    title: "2. Add another version",
    body: "A second key follows the same path. The MemTable keeps writes sorted and the WAL preserves their sequence numbers.",
    target: "#memtable-view",
    action: { type: "put", key: "user:43", value: "Lin" },
  },
  {
    title: "3. Flush to durable storage",
    body: "Flushing converts the MemTable into an immutable level-0 SSTable. The WAL checkpoint and Manifest update record that durable state.",
    target: "#levels-view",
    action: { type: "flush" },
  },
  {
    title: "4. Read the latest value",
    body: "A GET checks the MemTable and SSTables, using their metadata to skip files when possible. The resolved value appears here.",
    target: "#query-result",
    action: { type: "get", key: "user:42" },
  },
  {
    title: "5. Replay the event trace",
    body: "Every operation is captured in the event trace. Use its playback controls to inspect the exact state after each internal event.",
    target: ".timeline",
    action: null,
  },
  {
    title: "You are ready",
    body: "Try your own keys, flush the buffer, inspect an SSTable, or change the compaction strategy. You can reopen this tutorial from the top navigation.",
    target: ".workspace-grid",
    action: null,
  },
];

function isCompleted() {
  try {
    return window.localStorage.getItem(TUTORIAL_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function setCompleted() {
  try {
    window.localStorage.setItem(TUTORIAL_STORAGE_KEY, "true");
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

export function createTutorial({ execute, reset }) {
  const trigger = document.querySelector("#tutorial-button");
  const root = document.querySelector("#tutorial-root");
  if (!trigger || !root) return;

  let currentStep = 0;
  let previousFocus = null;
  let activeTarget = null;

  function close() {
    activeTarget?.classList.remove("tutorial-spotlight");
    activeTarget = null;
    root.hidden = true;
    root.innerHTML = "";
    document.body.classList.remove("tutorial-open");
    reset();
    if (previousFocus) previousFocus.focus();
    previousFocus = null;
  }

  function finish() {
    setCompleted();
    close();
  }

  function skip() {
    setCompleted();
    close();
  }

  function focusTarget(selector) {
    activeTarget?.classList.remove("tutorial-spotlight");
    const target = document.querySelector(selector);
    activeTarget = target;
    if (!activeTarget) return;
    activeTarget.classList.add("tutorial-spotlight");
    activeTarget.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function render() {
    const step = steps[currentStep];
    root.innerHTML = `
      <div class="tutorial-backdrop" data-tutorial-close></div>
      <section class="tutorial-dialog" role="dialog" aria-modal="true" aria-labelledby="tutorial-title" aria-describedby="tutorial-body">
        <div class="tutorial-progress">TUTORIAL · ${currentStep + 1} / ${steps.length}</div>
        <h2 id="tutorial-title">${step.title}</h2>
        <p id="tutorial-body">${step.body}</p>
        <div class="tutorial-actions">
          <button class="button button-secondary" type="button" data-tutorial-skip>Skip</button>
          <span class="tutorial-spacer"></span>
          <button class="button button-secondary" type="button" data-tutorial-back ${currentStep === 0 ? "disabled" : ""}>Back</button>
          <button class="button button-primary" type="button" data-tutorial-next>${currentStep === steps.length - 1 ? "Finish" : "Next"}</button>
        </div>
      </section>
    `;
    focusTarget(step.target);
    root.querySelector("[data-tutorial-next]").focus();
  }

  function next() {
    const step = steps[currentStep];
    if (step.action) {
      try {
        execute(step.action);
      } catch (error) {
        close();
        window.alert(`Tutorial could not continue: ${error.message}`);
        return;
      }
    }
    if (currentStep === steps.length - 1) finish();
    else {
      currentStep += 1;
      render();
    }
  }

  function back() {
    if (currentStep > 0) {
      reset();
      const previousStep = currentStep - 1;
      for (let index = 0; index < previousStep; index += 1) {
        if (steps[index].action) execute(steps[index].action);
      }
      currentStep = previousStep;
      render();
    }
  }

  function open() {
    previousFocus = document.activeElement;
    trigger.classList.remove("tutorial-new");
    currentStep = 0;
    reset();
    root.hidden = false;
    document.body.classList.add("tutorial-open");
    render();
  }

  root.addEventListener("click", (event) => {
    if (event.target.matches("[data-tutorial-close]")) close();
    if (event.target.matches("[data-tutorial-skip]")) skip();
    if (event.target.matches("[data-tutorial-next]")) next();
    if (event.target.matches("[data-tutorial-back]")) back();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Enter" && event.target.matches("[data-tutorial-next]")) next();
  });
  trigger.addEventListener("click", open);
  if (!isCompleted()) trigger.classList.add("tutorial-new");
}

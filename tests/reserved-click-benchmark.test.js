const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const popupJs = fs.readFileSync(path.join(root, "dist/popup.js"), "utf8");
const targetTime = Date.UTC(2026, 4, 20, 2, 15, 30, 0);
const initialNow = targetTime - 1200;

function createScheduler() {
  let now = initialNow;
  let nextId = 1;
  const tasks = new Map();

  function addTask(callback, runAt, interval = 0) {
    const id = nextId++;
    tasks.set(id, { callback, runAt, interval });
    return id;
  }

  function clearTask(id) {
    tasks.delete(id);
  }

  function runUntil(endTime) {
    while (true) {
      const next = Array.from(tasks.entries())
        .filter(([, task]) => task.runAt <= endTime)
        .sort((a, b) => a[1].runAt - b[1].runAt || a[0] - b[0])[0];

      if (!next) break;

      const [id, task] = next;
      now = task.runAt;

      if (task.interval) {
        task.runAt += task.interval;
      } else {
        tasks.delete(id);
      }

      task.callback();
    }

    now = endTime;
  }

  return {
    get now() {
      return now;
    },
    setTimeout(callback, delay) {
      return addTask(callback, now + Math.max(0, delay));
    },
    clearTimeout: clearTask,
    setInterval(callback, interval) {
      return addTask(callback, now + Math.max(1, interval), Math.max(1, interval));
    },
    clearInterval: clearTask,
    runUntil
  };
}

function createTarget(scheduler, readyAt) {
  return {
    innerText: "신청",
    textContent: "신청",
    value: "",
    acceptedClickAt: null,
    get disabled() {
      return scheduler.now < readyAt;
    },
    getAttribute(name) {
      if (name === "aria-disabled") return this.disabled ? "true" : null;
      return null;
    },
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    },
    scrollIntoView() {},
    click() {
      if (!this.disabled && this.acceptedClickAt === null) {
        this.acceptedClickAt = scheduler.now;
      }
    }
  };
}

function runWatchLoopScenario(readyOffsetMs) {
  const scheduler = createScheduler();
  const target = createTarget(scheduler, targetTime + readyOffsetMs);
  const storage = {};
  const elements = new Map();

  const document = {
    querySelector(selector) {
      if (selector === "#target") return target;
      if (!elements.has(selector)) elements.set(selector, { addEventListener() {}, append() {}, replaceChildren() {} });
      return elements.get(selector);
    },
    querySelectorAll(selector) {
      if (selector === "button, a, input[type='button'], input[type='submit'], [role='button']") return [target];
      return [];
    },
    addEventListener() {},
    createElement() {
      return { addEventListener() {}, append() {}, replaceChildren() {} };
    }
  };

  const context = {
    console,
    document,
    Date: class extends Date {
      constructor(...args) {
        super(...(args.length ? args : [scheduler.now]));
      }

      static now() {
        return scheduler.now;
      }

      static UTC(...args) {
        return Date.UTC(...args);
      }

      static parse(value) {
        return Date.parse(value);
      }
    },
    window: {
      getComputedStyle() {
        return {
          display: "block",
          visibility: "visible",
          opacity: "1",
          pointerEvents: "auto"
        };
      },
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
      setInterval: scheduler.setInterval,
      clearInterval: scheduler.clearInterval
    },
    chrome: {
      storage: {
        local: {
          async get() {
            return {};
          },
          set(values) {
            Object.assign(storage, values);
          },
          remove(key) {
            delete storage[key];
          }
        },
        onChanged: {
          addListener() {},
          removeListener() {}
        }
      }
    }
  };

  vm.createContext(context);
  vm.runInContext(popupJs, context);
  context.installReservedClick(createSchedule(), createKeys());
  scheduler.runUntil(targetTime + 5200);

  return {
    acceptedClickAt: target.acceptedClickAt,
    latencyMs: target.acceptedClickAt === null ? null : target.acceptedClickAt - (targetTime + readyOffsetMs),
    status: storage.reservedClickStatus?.state
  };
}

function runLegacyScenario(readyOffsetMs) {
  const scheduler = createScheduler();
  const target = createTarget(scheduler, targetTime + readyOffsetMs);
  scheduler.setTimeout(() => {
    target.scrollIntoView({ block: "center", inline: "center" });
    target.click();
  }, targetTime - scheduler.now);
  scheduler.runUntil(targetTime + 5200);

  return {
    acceptedClickAt: target.acceptedClickAt,
    latencyMs: target.acceptedClickAt === null ? null : target.acceptedClickAt - (targetTime + readyOffsetMs)
  };
}

function createSchedule() {
  return {
    targetAt: "2026-05-20 11:15:30.000",
    timeOffset: 0,
    buttonText: "신청",
    targetIndex: 0,
    selectedTarget: {
      selector: "#target",
      buttonText: "신청",
      targetIndex: 0
    }
  };
}

function createKeys() {
  return {
    statusKey: "reservedClickStatus",
    scheduleKey: "reservedClickSchedule"
  };
}

const scenarios = [0, 50, 123, 1500, 6000];
const rows = scenarios.map((readyOffsetMs) => {
  const legacy = runLegacyScenario(readyOffsetMs);
  const watchLoop = runWatchLoopScenario(readyOffsetMs);

  return {
    readyOffsetMs,
    legacyLatencyMs: legacy.latencyMs,
    watchLoopLatencyMs: watchLoop.latencyMs,
    watchLoopStatus: watchLoop.status
  };
});

assert.deepStrictEqual(
  rows.map((row) => row.legacyLatencyMs),
  [0, null, null, null, null],
  "legacy one-shot click only succeeds when the target is ready exactly at the scheduled time"
);

assert.deepStrictEqual(
  rows.map((row) => row.watchLoopLatencyMs),
  [0, 0, 7, 0, null],
  "watch loop should click on the next polling tick after the target becomes clickable"
);

console.table(rows);
console.log("reserved click benchmark comparison passed");

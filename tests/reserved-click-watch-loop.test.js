const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const popupJs = fs.readFileSync(path.join(root, "dist/popup.js"), "utf8");

function createElement() {
  return {
    value: "",
    checked: false,
    textContent: "",
    addEventListener() {},
    replaceChildren() {},
    append() {},
    getBoundingClientRect() {
      return { width: 1, height: 1 };
    }
  };
}

const target = {
  disabled: true,
  clicked: 0,
  innerText: "신청",
  textContent: "신청",
  value: "",
  getAttribute(name) {
    if (name === "aria-disabled") return this.ariaDisabled ?? null;
    return null;
  },
  getBoundingClientRect() {
    return { width: 120, height: 40 };
  },
  scrollIntoView() {},
  click() {
    this.clicked += 1;
  }
};

const elements = new Map();
const document = {
  querySelector(selector) {
    if (selector === "#target") return target;
    if (!elements.has(selector)) elements.set(selector, createElement());
    return elements.get(selector);
  },
  querySelectorAll(selector) {
    if (selector === "button, a, input[type='button'], input[type='submit'], [role='button']") return [target];
    return [];
  },
  addEventListener() {},
  createElement
};

const fixedNow = Date.UTC(2026, 4, 20, 2, 15, 29, 200);
let currentNow = fixedNow;
const storage = {};
let timeoutCallback;
let timeoutDelay;
let intervalCallback;

const context = {
  console,
  document,
  Date: class extends Date {
    constructor(...args) {
      super(...(args.length ? args : [currentNow]));
    }

    static now() {
      return currentNow;
    }

    static UTC(...args) {
      return Date.UTC(...args);
    }

    static parse(value) {
      return Date.parse(value);
    }
  },
  window: {
    __reservedClickTimerId: undefined,
    __reservedClickWatchIntervalId: undefined,
    getComputedStyle() {
      return {
        display: "block",
        visibility: "visible",
        opacity: "1",
        pointerEvents: "auto"
      };
    },
    setTimeout(callback, delay) {
      timeoutCallback = callback;
      timeoutDelay = delay;
      return 1;
    },
    clearTimeout() {},
    setInterval(callback) {
      intervalCallback = callback;
      return 2;
    },
    clearInterval() {}
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

context.installReservedClick(
  {
    targetAt: "2026-05-20 11:15:30.000",
    timeOffset: 0,
    buttonText: "신청",
    targetIndex: 0,
    selectedTarget: {
      selector: "#target",
      buttonText: "신청",
      targetIndex: 0
    }
  },
  {
    statusKey: "reservedClickStatus",
    scheduleKey: "reservedClickSchedule"
  }
);

assert.strictEqual(timeoutDelay, 0, "watch loop must start before the scheduled time when within lead time");
assert.strictEqual(target.clicked, 0, "target must not be clicked before the watch loop runs");

timeoutCallback();

assert.strictEqual(target.clicked, 0, "disabled target must not be clicked");
assert.strictEqual(typeof intervalCallback, "function", "watch loop must keep polling while the target is not clickable");

target.disabled = false;
intervalCallback();

assert.strictEqual(target.clicked, 0, "target must not be clicked before the scheduled time");

currentNow = Date.UTC(2026, 4, 20, 2, 15, 30, 0);
intervalCallback();

assert.strictEqual(target.clicked, 1, "target must be clicked once it is clickable at the scheduled time");
assert.strictEqual(storage.reservedClickStatus.state, "clicked");

console.log("reserved click watch loop waits for clickable target");

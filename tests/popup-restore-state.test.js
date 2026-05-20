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
    append() {}
  };
}

const elements = new Map();
const document = {
  querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, createElement());
    return elements.get(selector);
  },
  addEventListener(eventName, handler) {
    if (eventName === "DOMContentLoaded") this.restoreState = handler;
  },
  createElement
};

const fixedNow = Date.UTC(2026, 4, 20, 2, 15, 30);
const storage = {
  reservedClickSchedule: {
    targetAt: "2099-12-31 23:59:59.950"
  },
  reservedClickStatus: {
    state: "scheduled",
    scheduledFor: "2099-12-31 23:59:59.950"
  }
};

const context = {
  console,
  document,
  Date: class extends Date {
    constructor(...args) {
      super(...(args.length ? args : [fixedNow]));
    }

    static now() {
      return fixedNow;
    }

    static UTC(...args) {
      return Date.UTC(...args);
    }

    static parse(value) {
      return Date.parse(value);
    }
  },
  chrome: {
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, storage[key]]));
          }
          return { [keys]: storage[keys] };
        },
        async set(values) {
          Object.assign(storage, values);
        },
        async remove(key) {
          delete storage[key];
        }
      },
      onChanged: {
        addListener() {}
      }
    },
    tabs: {
      async query() {
        return [];
      }
    },
    scripting: {
      async executeScript() {
        throw new Error("not available in unit test");
      }
    }
  },
  window: {
    setTimeout() {
      return 1;
    },
    clearTimeout() {}
  }
};

vm.createContext(context);
vm.runInContext(popupJs, context);

async function main() {
  await document.restoreState();

  assert.strictEqual(elements.get("#target-date").value, "2026-05-20");
  assert.strictEqual(elements.get("#target-time").value, "11:15:30");
  assert.strictEqual(elements.get("#target-millisecond").value, "950");

  delete storage.reservedClickSchedule;
  await document.restoreState();

  assert.strictEqual(elements.get("#target-date").value, "2026-05-20");
  assert.strictEqual(elements.get("#target-time").value, "11:15:30");
  assert.strictEqual(elements.get("#target-millisecond").value, "000");
}

main()
  .then(() => console.log("popup restore state uses current date/time inputs"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

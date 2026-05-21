const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "dist/manifest.json"), "utf8"));
const popupJs = fs.readFileSync(path.join(root, "dist/popup.js"), "utf8");
const backgroundJs = fs.readFileSync(path.join(root, "dist/background.js"), "utf8");

assert.strictEqual(manifest.background.service_worker, "background.js");
assert(
  manifest.permissions.includes("tabs"),
  "manifest must include tabs permission so saved popup target tabs can be read later"
);
assert(
  manifest.commands["open-reserved-click"],
  "manifest must expose a shortcut command for opening the extension window"
);

async function verifyBackgroundOpensExtensionWindowFromActiveTab() {
  const storage = {};
  const createdWindows = [];
  let commandHandler;

  const context = {
    console,
    chrome: {
      commands: {
        onCommand: {
          addListener(handler) {
            commandHandler = handler;
          }
        }
      },
      runtime: {
        getURL(file) {
          return `chrome-extension://reserved-click/${file}`;
        }
      },
      storage: {
        local: {
          async set(values) {
            Object.assign(storage, values);
          }
        }
      },
      tabs: {
        async query(options) {
          assert.strictEqual(options.active, true);
          assert.strictEqual(options.currentWindow, true);
          return [{
            id: 44,
            windowId: 8,
            url: "https://ticket.example/popup",
            title: "Ticket Popup"
          }];
        }
      },
      windows: {
        async create(options) {
          createdWindows.push(options);
          return { id: 99 };
        }
      }
    }
  };

  vm.createContext(context);
  vm.runInContext(backgroundJs, context);

  assert.strictEqual(typeof commandHandler, "function");
  await commandHandler("open-reserved-click");

  assert.strictEqual(storage.reservedClickTargetContext.tabId, 44);
  assert.strictEqual(storage.reservedClickTargetContext.windowId, 8);
  assert.strictEqual(storage.reservedClickTargetContext.url, "https://ticket.example/popup");
  assert.strictEqual(storage.reservedClickTargetContext.title, "Ticket Popup");
  assert.strictEqual(createdWindows.length, 1);
  assert.strictEqual(createdWindows[0].url, "chrome-extension://reserved-click/popup.html?target=stored");
  assert.strictEqual(createdWindows[0].type, "popup");
}

async function verifyPopupUsesSavedTargetTab() {
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
    addEventListener() {},
    createElement
  };

  const storage = {
    reservedClickTargetContext: {
      tabId: 44,
      windowId: 8,
      url: "https://ticket.example/popup",
      title: "Ticket Popup"
    }
  };
  const queriedTabs = [];
  const readTabs = [];

  const context = {
    console,
    document,
    Date,
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
        async get(tabId) {
          readTabs.push(tabId);
          return { id: tabId, windowId: 8, url: "https://ticket.example/popup" };
        },
        async query(options) {
          queriedTabs.push(options);
          return [{ id: 999, windowId: 100, url: "chrome-extension://reserved-click/popup.html" }];
        }
      },
      scripting: {
        async executeScript() {
          return [{
            result: {
              serverTime: Date.now(),
              clientTime: Date.now()
            }
          }];
        }
      }
    },
    window: {
      location: {
        search: "?target=stored"
      },
      setTimeout() {
        return 1;
      },
      clearTimeout() {}
    }
  };

  vm.createContext(context);
  vm.runInContext(popupJs, context);

  const targetTab = await context.getTargetTab();
  assert.strictEqual(targetTab.id, 44);
  assert.strictEqual(readTabs.length, 1);
  assert.strictEqual(readTabs[0], 44);
  assert.strictEqual(queriedTabs.length, 0);
}

Promise.resolve()
  .then(verifyBackgroundOpensExtensionWindowFromActiveTab)
  .then(verifyPopupUsesSavedTargetTab)
  .then(() => console.log("extension window target context checks passed"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const popupHtml = fs.readFileSync(path.join(root, "dist/popup.html"), "utf8");
const popupJs = fs.readFileSync(path.join(root, "dist/popup.js"), "utf8");
const popupCss = fs.readFileSync(path.join(root, "dist/popup.css"), "utf8");

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

const context = {
  console,
  document,
  Date,
  chrome: {
    storage: {
      local: {
        async get() {
          return {};
        },
        async set() {},
        async remove() {}
      },
      onChanged: {
        addListener() {}
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

assert(
  popupHtml.includes('id="target-time"') && popupHtml.includes('step="1"'),
  "time input must stay at second precision"
);

assert(
  popupHtml.includes('id="target-millisecond"') &&
    popupHtml.includes('<option value="000">000</option>') &&
    popupHtml.includes('<option value="800">800</option>') &&
    popupHtml.includes('<option value="850">850</option>') &&
    popupHtml.includes('<option value="900">900</option>') &&
    popupHtml.includes('<option value="950">950</option>'),
  "millisecond input must offer only 000, 800, 850, 900, and 950"
);

assert(
  !popupCss.includes("grid-template-columns: 1.15fr 1fr 72px"),
  "date, time, and millisecond controls must not be squeezed into one row"
);

assert.strictEqual(context.normalizeTimeValue("08:59:59"), "08:59:59");
assert.strictEqual(context.normalizeMillisecondValue("000"), "000");
assert.strictEqual(context.normalizeMillisecondValue("800"), "800");
assert.strictEqual(context.normalizeMillisecondValue("850"), "850");
assert.strictEqual(context.normalizeMillisecondValue("900"), "900");
assert.strictEqual(context.normalizeMillisecondValue("950"), "950");

assert.strictEqual(context.normalizeTimeValue("08:59:59.800"), "");
assert.strictEqual(context.normalizeMillisecondValue("799"), "");
assert.strictEqual(context.normalizeMillisecondValue("875"), "");
assert.strictEqual(context.normalizeMillisecondValue("999"), "");

assert.strictEqual(
  context.parseKoreanDateTime("2026-05-20 08:59:59.850").getTime(),
  Date.UTC(2026, 4, 19, 23, 59, 59, 850)
);

assert.strictEqual(
  context.formatLocalDateTimeForDisplay(new Date(Date.UTC(2026, 4, 19, 23, 59, 59, 850))),
  "2026-05-20 08:59:59.850"
);

console.log("popup millisecond time checks passed");

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.existsSync(path.join(root, file))
  ? fs.readFileSync(path.join(root, file), "utf8")
  : "";

const manifest = JSON.parse(read("dist/manifest.json"));
const popupHtml = read("dist/popup.html");
const popupJs = read("dist/popup.js");
const popupCss = read("dist/popup.css");
const contentJsPath = path.join(root, "dist/content.js");

assert(
  !popupHtml.includes("refresh-before-click") &&
    !popupHtml.includes("예약 시간 1초 전에 새로고침 후 클릭"),
  "popup must not expose the refresh-before-click option"
);

assert(
  !popupJs.includes("refreshBeforeClick") &&
    !popupJs.includes("REFRESH_BEFORE_CLICK_MS") &&
    !popupJs.includes("refreshedBeforeClick") &&
    !popupJs.includes("location.reload()"),
  "popup script must not contain refresh-before-click scheduling logic"
);

assert(
  !popupCss.includes("option-row"),
  "popup styles must not keep refresh option-only CSS"
);

assert(
  !Array.isArray(manifest.host_permissions) &&
    !Array.isArray(manifest.content_scripts),
  "manifest must not grant broad host permissions or register content.js for refresh recovery"
);

assert(
  !fs.existsSync(contentJsPath),
  "content.js must be removed because refresh recovery is no longer supported"
);

console.log("refresh-before-click removal checks passed");

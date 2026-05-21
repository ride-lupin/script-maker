const STATUS_KEY = "reservedClickStatus";
const SCHEDULE_KEY = "reservedClickSchedule";
const SELECTED_TARGET_KEY = "reservedClickSelectedTarget";
const TARGET_CONTEXT_KEY = "reservedClickTargetContext";
const USE_STORED_TARGET_CONTEXT = (window.location?.search ?? "").split(/[?&]/).includes("target=stored");

const form = document.querySelector("#schedule-form");
const targetDateInput = document.querySelector("#target-date");
const targetTimeInput = document.querySelector("#target-time");
const targetMillisecondInput = document.querySelector("#target-millisecond");
const selectButton = document.querySelector("#select-button");
const selectedTarget = document.querySelector("#selected-target");
const cancelButton = document.querySelector("#cancel-button");
const statusList = document.querySelector("#status-list");
const currentTimeLabel = document.querySelector("#current-time-label");
const currentTimeValue = document.querySelector("#current-time-value");

const MAX_SERVER_TIME_DRIFT_MS = 10 * 60 * 1000;
const DATE_HEADER_PRECISION_OFFSET_MS = 500;
const CLOCK_RENDER_INTERVAL_MS = 50;
const ALLOWED_TARGET_MILLISECONDS = [0, 800, 850, 900, 950];

let currentTimeTimerId;
let serverTimeOffset = 0;
let currentTimeSource = "device";

document.addEventListener("DOMContentLoaded", restoreState);
form.addEventListener("submit", scheduleClick);
selectButton.addEventListener("click", startBrowserSelection);
cancelButton.addEventListener("click", cancelSchedule);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes[STATUS_KEY]?.newValue) {
    renderStatus(changes[STATUS_KEY].newValue);
  }

  if (changes[SELECTED_TARGET_KEY]) {
    renderSelectedTarget(changes[SELECTED_TARGET_KEY].newValue);
  }
});

async function restoreState() {
  startCurrentTimeClock();
  await refreshServerTime();

  const {
    [STATUS_KEY]: status,
    [SCHEDULE_KEY]: schedule,
    [SELECTED_TARGET_KEY]: selected
  } = await chrome.storage.local.get([STATUS_KEY, SCHEDULE_KEY, SELECTED_TARGET_KEY]);

  setCurrentDateTime(schedule);

  renderSelectedTarget(selected);
  renderStatus(status ?? { state: "idle" });
}

async function scheduleClick(event) {
  event.preventDefault();

  const targetAt = buildTargetAt();
  const targetDate = parseKoreanDateTime(targetAt);

  if (!targetDate) {
    await saveFailure({ targetAt, error: "날짜와 시간을 선택해야 합니다." });
    return;
  }

  if (targetDate.getTime() <= getCurrentTime().getTime()) {
    await saveFailure({ targetAt, error: "이미 지난 실행 일시입니다." });
    return;
  }

  const schedule = await buildSchedule(targetAt);
  if (!schedule.ok) {
    await saveFailure({ targetAt, ...schedule.status, error: schedule.error });
    return;
  }

  const clickSchedule = schedule.value;
  clickSchedule.timeOffset = serverTimeOffset;
  clickSchedule.timeSource = currentTimeSource;

  const status = {
    state: "scheduled",
    scheduledFor: targetAt,
    buttonText: clickSchedule.buttonText,
    targetIndex: Number.isInteger(clickSchedule.targetIndex) ? clickSchedule.targetIndex + 1 : undefined,
    selector: clickSchedule.selectedTarget?.selector
  };

  await chrome.storage.local.set({
    [SCHEDULE_KEY]: clickSchedule,
    [STATUS_KEY]: status
  });

  renderStatus(status);

  try {
    const tab = await getTargetTab();
    if (!tab?.id) throw new Error("현재 탭을 찾을 수 없습니다.");

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: installReservedClick,
      args: [clickSchedule, { statusKey: STATUS_KEY, scheduleKey: SCHEDULE_KEY }]
    });
  } catch (error) {
    await saveFailure({ targetAt, ...status, error: toMessage(error) });
  }
}

async function buildSchedule(targetAt) {
  const { [SELECTED_TARGET_KEY]: selected } = await chrome.storage.local.get(SELECTED_TARGET_KEY);

  if (!selected?.selector) {
    return {
      ok: false,
      error: "브라우저에서 클릭할 버튼을 먼저 선택해야 합니다.",
      status: {}
    };
  }

  return {
    ok: true,
    value: {
      targetAt,
      timeOffset: 0,
      timeSource: "device",
      buttonText: selected.buttonText ?? "",
      targetIndex: Number.isInteger(selected.targetIndex) ? selected.targetIndex : undefined,
      selectedTarget: selected
    }
  };
}

async function startBrowserSelection() {
  try {
    const tab = await getTargetTab();
    if (!tab?.id) throw new Error("현재 탭을 찾을 수 없습니다.");

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: installButtonPicker,
      args: [{ selectedTargetKey: SELECTED_TARGET_KEY, statusKey: STATUS_KEY }]
    });

    renderSelectedTarget({ label: "페이지에서 버튼을 선택하세요." });
  } catch (error) {
    await saveFailure({ error: toMessage(error) });
  }
}

async function cancelSchedule() {
  const status = {
    state: "cancelled",
    error: "사용자가 예약을 취소했습니다."
  };

  await chrome.storage.local.set({ [STATUS_KEY]: status });
  await chrome.storage.local.remove(SCHEDULE_KEY);
  renderStatus(status);

  try {
    const tab = await getTargetTab();
    if (!tab?.id) return;

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: cancelReservedClick
    });
  } catch {
    // Storage state is already cancelled; injection failure does not change the user-visible result.
  }
}

async function saveFailure({ targetAt, buttonText, targetIndex, selector, error }) {
  const status = {
    state: "failed",
    scheduledFor: targetAt || undefined,
    buttonText: buttonText || undefined,
    targetIndex: Number.isInteger(targetIndex) ? targetIndex : undefined,
    selector,
    error
  };

  await chrome.storage.local.set({ [STATUS_KEY]: status });
  renderStatus(status);
}

function renderStatus(status) {
  const rows = [
    ["결과", status.state ?? "idle", "state"],
    ["예약 시각", status.scheduledFor],
    ["클릭 시각", status.clickedAt],
    ["버튼명", status.buttonText],
    ["순번", status.targetIndex],
    ["매칭 개수", status.matchedCount],
    ["실패 사유", status.error]
  ].filter(([, value]) => value !== undefined && value !== "");

  statusList.replaceChildren(...rows.flatMap(([label, value]) => {
    const term = document.createElement("dt");
    term.textContent = label;

    const description = document.createElement("dd");
    if (label === "결과") {
      const badge = document.createElement("span");
      badge.className = `status-badge status-${value}`;
      badge.textContent = formatState(value);
      description.append(badge);
    } else {
      description.textContent = String(value);
    }

    return [term, description];
  }));
}

function startCurrentTimeClock() {
  stopCurrentTimeClock();
  scheduleCurrentTimeTick();
}

function stopCurrentTimeClock() {
  if (!currentTimeTimerId) return;
  window.clearTimeout(currentTimeTimerId);
  currentTimeTimerId = undefined;
}

function scheduleCurrentTimeTick() {
  renderCurrentTime();
  currentTimeTimerId = window.setTimeout(scheduleCurrentTimeTick, CLOCK_RENDER_INTERVAL_MS);
}

async function refreshServerTime() {
  try {
    const tab = await getTargetTab();
    if (!tab?.id) throw new Error("현재 탭을 찾을 수 없습니다.");

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readServerTimeSnapshot
    });

    const snapshot = result?.result;
    if (!snapshot?.serverTime || !snapshot?.clientTime) throw new Error("서버 시각을 읽을 수 없습니다.");

    const offset = snapshot.serverTime + DATE_HEADER_PRECISION_OFFSET_MS - snapshot.clientTime;
    if (Math.abs(offset) > MAX_SERVER_TIME_DRIFT_MS) throw new Error("서버 시각 오차가 너무 큽니다.");

    serverTimeOffset = offset;
    currentTimeSource = "server";
  } catch {
    serverTimeOffset = 0;
    currentTimeSource = "device";
  }

  stopCurrentTimeClock();
  scheduleCurrentTimeTick();
}

async function getTargetTab() {
  if (USE_STORED_TARGET_CONTEXT) {
    const { [TARGET_CONTEXT_KEY]: targetContext } = await chrome.storage.local.get(TARGET_CONTEXT_KEY);

    if (targetContext?.tabId) {
      try {
        const tab = await chrome.tabs.get(targetContext.tabId);
        if (tab?.id && !tab.url?.startsWith("chrome-extension://")) return tab;
      } catch {
        await chrome.storage.local.remove(TARGET_CONTEXT_KEY);
      }
    }
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && !tab.url?.startsWith("chrome-extension://")) return tab;
  return undefined;
}

function getCurrentTime() {
  return new Date(Date.now() + serverTimeOffset);
}

function renderCurrentTime() {
  const now = getCurrentTime();
  currentTimeLabel.textContent = currentTimeSource === "server" ? "현재 시각 · 서버 기준 · 한국 시간" : "현재 시각 · 기기 기준 · 한국 시간";
  currentTimeValue.textContent = formatLocalDateTimeForDisplay(now);
}

function renderSelectedTarget(target) {
  if (!target) {
    selectedTarget.textContent = "선택된 버튼 없음";
    return;
  }

  if (target.label) {
    selectedTarget.textContent = target.label;
    return;
  }

  const label = target.buttonText || target.selector || "이름 없는 버튼";
  const parts = [label];

  if (Number.isInteger(target.targetIndex)) {
    parts.push(`${target.targetIndex + 1}번째 후보`);
  }

  if (Number.isInteger(target.matchedCount)) {
    parts.push(`총 ${target.matchedCount}개 매칭`);
  }

  selectedTarget.textContent = parts.join(" · ");
}

function buildTargetAt() {
  const date = targetDateInput.value.trim();
  const time = normalizeTimeValue(targetTimeInput.value.trim());
  const millisecond = normalizeMillisecondValue(targetMillisecondInput.value.trim());

  if (!date || !time || !millisecond) return "";
  return `${date} ${time}.${millisecond}`;
}

function setCurrentDateTime(schedule) {
  const defaultTargetDate = roundUpToAllowedTargetMillisecond(getCurrentTime());
  targetDateInput.value = formatDateInput(defaultTargetDate);
  targetTimeInput.value = formatTimeInput(defaultTargetDate);
  targetMillisecondInput.value = resolveInitialMillisecond(schedule);
}

function normalizeTimeValue(value) {
  const match = value.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return "";

  const [, hour, minute, second = "00"] = match;
  const numericHour = Number(hour);
  const numericMinute = Number(minute);
  const numericSecond = Number(second);

  if (
    numericHour > 23 ||
    numericMinute > 59 ||
    numericSecond > 59
  ) {
    return "";
  }

  return `${hour}:${minute}:${second}`;
}

function normalizeMillisecondValue(value) {
  if (!/^\d{3}$/.test(value)) return "";
  const millisecond = Number(value);
  if (!ALLOWED_TARGET_MILLISECONDS.includes(millisecond)) return "";
  return value;
}

function resolveInitialMillisecond(schedule) {
  const scheduledMillisecond = parseDateTimeParts(schedule?.targetAt ?? "")?.millisecond;
  if (Number.isInteger(scheduledMillisecond)) {
    return normalizeMillisecondValue(String(scheduledMillisecond).padStart(3, "0")) || "000";
  }

  return "000";
}

function roundUpToAllowedTargetMillisecond(date) {
  const normalized = new Date(date.getTime());
  const currentMillisecond = normalized.getMilliseconds();
  const nextMillisecond = ALLOWED_TARGET_MILLISECONDS.find((millisecond) => currentMillisecond < millisecond);

  if (nextMillisecond === undefined) {
    normalized.setSeconds(normalized.getSeconds() + 1, ALLOWED_TARGET_MILLISECONDS[0]);
    return normalized;
  }

  normalized.setMilliseconds(nextMillisecond);
  return normalized;
}

function parseDateTimeParts(value) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?$/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second, millisecond = "000"] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    millisecond: Number(millisecond)
  };
}

function formatDateInput(date) {
  const parts = getKoreanDateTimeParts(date);
  return [
    parts.year,
    parts.month,
    parts.day
  ].join("-");
}

function formatTimeInput(date) {
  const parts = getKoreanDateTimeParts(date);
  return [
    parts.hour,
    parts.minute,
    parts.second
  ].join(":");
}

function formatMillisecondInput(date) {
  return getKoreanDateTimeParts(date).millisecond;
}

function formatLocalDateTimeForDisplay(date) {
  return `${formatDateInput(date)} ${formatTimeInput(date)}.${formatMillisecondInput(date)}`;
}

function getKoreanDateTimeParts(date) {
  const koreanTime = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");

  return {
    year: String(koreanTime.getUTCFullYear()),
    month: pad(koreanTime.getUTCMonth() + 1),
    day: pad(koreanTime.getUTCDate()),
    hour: pad(koreanTime.getUTCHours()),
    minute: pad(koreanTime.getUTCMinutes()),
    second: pad(koreanTime.getUTCSeconds()),
    millisecond: String(koreanTime.getUTCMilliseconds()).padStart(3, "0")
  };
}

function parseKoreanDateTime(value) {
  const partsToParse = parseDateTimeParts(value);
  if (!partsToParse) return null;

  const { year, month, day, hour, minute, second, millisecond } = partsToParse;
  const date = new Date(Date.UTC(year, month - 1, day, hour - 9, minute, second, millisecond));
  const parts = getKoreanDateTimeParts(date);

  if (
    Number(parts.year) !== year ||
    Number(parts.month) !== month ||
    Number(parts.day) !== day ||
    Number(parts.hour) !== hour ||
    Number(parts.minute) !== minute ||
    Number(parts.second) !== second ||
    Number(parts.millisecond) !== millisecond
  ) {
    return null;
  }

  return date;
}

function toMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatState(state) {
  const labels = {
    idle: "대기",
    scheduled: "예약됨",
    clicked: "클릭 완료",
    failed: "실패",
    cancelled: "취소됨"
  };

  return labels[state] ?? String(state);
}

async function readServerTimeSnapshot() {
  async function fetchDateHeader(method) {
    const response = await fetch(window.location.href, {
      method,
      cache: "no-store",
      credentials: "include"
    });

    return response.headers.get("date");
  }

  const startedAt = Date.now();
  let dateHeader;

  try {
    dateHeader = await fetchDateHeader("HEAD");
  } catch {
    dateHeader = await fetchDateHeader("GET");
  }

  const endedAt = Date.now();
  const serverTime = Date.parse(dateHeader);
  if (!Number.isFinite(serverTime)) return null;

  return {
    serverTime,
    clientTime: Math.round((startedAt + endedAt) / 2)
  };
}

function installButtonPicker(keys) {
  const selector = "button, a, input[type='button'], input[type='submit'], [role='button']";
  const rootId = "__reservedClickPickerRoot";
  const styleId = "__reservedClickPickerStyle";
  let hoveredElement;

  function teardown() {
    document.removeEventListener("mouseover", handleMouseOver, true);
    document.removeEventListener("mouseout", handleMouseOut, true);
    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("keydown", handleKeyDown, true);
    document.querySelectorAll("[data-reserved-click-pickable='true']").forEach((element) => {
      element.removeAttribute("data-reserved-click-pickable");
      element.style.outline = element.dataset.reservedClickPreviousOutline ?? "";
      element.style.cursor = element.dataset.reservedClickPreviousCursor ?? "";
      delete element.dataset.reservedClickPreviousOutline;
      delete element.dataset.reservedClickPreviousCursor;
    });
    document.querySelector(`#${rootId}`)?.remove();
    document.querySelector(`#${styleId}`)?.remove();
  }

  function getText(element) {
    return [
      element.innerText,
      element.textContent,
      element.value,
      element.getAttribute("aria-label"),
      element.getAttribute("title")
    ].map((value) => String(value ?? "").replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  }

  function normalizeText(value) {
    return String(value).replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) > 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function findCandidates(buttonText) {
    const normalizedNeedle = normalizeText(buttonText);

    return Array.from(document.querySelectorAll(selector)).filter((element) => {
      if (!isVisible(element)) return false;
      if (!normalizedNeedle) return true;
      return normalizeText(getText(element)).includes(normalizedNeedle);
    });
  }

  function cssPath(element) {
    if (element.id) {
      const idSelector = `${element.tagName.toLowerCase()}#${CSS.escape(element.id)}`;
      if (document.querySelectorAll(idSelector).length === 1) return idSelector;
    }

    const parts = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      const tagName = current.tagName.toLowerCase();
      const siblings = Array.from(current.parentElement?.children ?? []).filter((child) => child.tagName === current.tagName);
      const index = siblings.indexOf(current) + 1;
      parts.unshift(`${tagName}:nth-of-type(${index})`);
      current = current.parentElement;
    }

    return `body > ${parts.join(" > ")}`;
  }

  function buildTarget(element) {
    const buttonText = getText(element);
    const matchingCandidates = findCandidates(buttonText);

    return {
      selector: cssPath(element),
      buttonText,
      targetIndex: matchingCandidates.indexOf(element),
      tagName: element.tagName.toLowerCase(),
      matchedCount: matchingCandidates.length
    };
  }

  function handleMouseOver(event) {
    const target = event.target.closest(selector);
    if (!target || !isVisible(target)) return;

    hoveredElement = target;
    target.style.outline = "3px solid #1677c7";
  }

  function handleMouseOut(event) {
    const target = event.target.closest(selector);
    if (!target || target !== hoveredElement) return;

    target.style.outline = target.dataset.reservedClickPreviousOutline ?? "";
    hoveredElement = undefined;
  }

  function handleClick(event) {
    const target = event.target.closest(selector);
    if (!target || !isVisible(target)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const selectedTarget = buildTarget(target);
    chrome.storage.local.set({
      [keys.selectedTargetKey]: selectedTarget,
      [keys.statusKey]: {
        state: "idle",
        buttonText: selectedTarget.buttonText,
        targetIndex: selectedTarget.targetIndex + 1,
        selector: selectedTarget.selector,
        matchedCount: selectedTarget.matchedCount
      }
    });
    teardown();
  }

  function handleKeyDown(event) {
    if (event.key !== "Escape") return;
    teardown();
  }

  teardown();

  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = `
    [data-reserved-click-pickable='true'] {
      outline: 2px dashed #1677c7 !important;
      outline-offset: 3px !important;
    }
  `;
  document.documentElement.append(style);

  const banner = document.createElement("div");
  banner.id = rootId;
  banner.textContent = "예약 클릭 대상으로 사용할 버튼을 선택하세요. 취소하려면 Esc를 누르세요.";
  banner.style.cssText = [
    "position: fixed",
    "z-index: 2147483647",
    "top: 12px",
    "left: 50%",
    "transform: translateX(-50%)",
    "max-width: min(520px, calc(100vw - 24px))",
    "border: 1px solid #0f5f9f",
    "border-radius: 6px",
    "padding: 10px 12px",
    "font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    "color: #ffffff",
    "background: #1677c7",
    "box-shadow: 0 8px 28px rgba(15, 35, 55, 0.22)"
  ].join(";");
  document.documentElement.append(banner);

  const candidates = Array.from(document.querySelectorAll(selector)).filter(isVisible);
  candidates.forEach((element) => {
    element.dataset.reservedClickPickable = "true";
    element.dataset.reservedClickPreviousOutline = element.style.outline;
    element.dataset.reservedClickPreviousCursor = element.style.cursor;
    element.style.cursor = "crosshair";
  });

  document.addEventListener("mouseover", handleMouseOver, true);
  document.addEventListener("mouseout", handleMouseOut, true);
  document.addEventListener("click", handleClick, true);
  document.addEventListener("keydown", handleKeyDown, true);
}

function installReservedClick(schedule, keys) {
  const WATCH_LEAD_TIME_MS = 1000;
  const WATCH_INTERVAL_MS = 10;
  const WATCH_TIMEOUT_MS = 5000;

  function clearTimer() {
    if (window.__reservedClickTimerId) {
      window.clearTimeout(window.__reservedClickTimerId);
      window.__reservedClickTimerId = undefined;
    }
  }

  function clearWatchInterval() {
    if (window.__reservedClickWatchIntervalId) {
      window.clearInterval(window.__reservedClickWatchIntervalId);
      window.__reservedClickWatchIntervalId = undefined;
    }
  }

  function removeStorageListener() {
    if (window.__reservedClickStorageListener) {
      chrome.storage.onChanged.removeListener(window.__reservedClickStorageListener);
      window.__reservedClickStorageListener = undefined;
    }
  }

  function findCandidates(buttonText) {
    const selector = "button, a, input[type='button'], input[type='submit'], [role='button']";
    const normalizedNeedle = normalizeText(buttonText);

    return Array.from(document.querySelectorAll(selector)).filter((element) => {
      if (!isVisible(element)) return false;
      if (!normalizedNeedle) return true;

      const haystack = normalizeText([
        element.innerText,
        element.textContent,
        element.value,
        element.getAttribute("aria-label"),
        element.getAttribute("title")
      ].filter(Boolean).join(" "));

      return haystack.includes(normalizedNeedle);
    });
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) > 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function normalizeText(value) {
    return String(value).replace(/\s+/g, " ").trim().toLowerCase();
  }

  function findSelectedTarget(selectedTarget) {
    if (!selectedTarget) return null;

    if (selectedTarget.selector) {
      const selectedElement = document.querySelector(selectedTarget.selector);
      if (selectedElement && isVisible(selectedElement)) return selectedElement;
    }

    if (selectedTarget.buttonText && Number.isInteger(selectedTarget.targetIndex)) {
      return findCandidates(selectedTarget.buttonText)[selectedTarget.targetIndex] ?? null;
    }

    return null;
  }

  function isClickable(element) {
    if (!element || !isVisible(element)) return false;

    const style = window.getComputedStyle(element);

    return (
      element.disabled !== true &&
      element.getAttribute("aria-disabled") !== "true" &&
      style.pointerEvents !== "none"
    );
  }

  function countMatchesForSchedule() {
    if (schedule.selectedTarget?.buttonText) {
      return findCandidates(schedule.selectedTarget.buttonText).length;
    }

    return 0;
  }

  function writeStatus(status) {
    chrome.storage.local.set({ [keys.statusKey]: status });

    if (status.state !== "scheduled") {
      chrome.storage.local.remove(keys.scheduleKey);
    }
  }

  function parseKoreanDateTimeInInjectedPage(value) {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?$/);
    const [, year, month, day, hour, minute, second, millisecond = "000"] = match;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 9, Number(minute), Number(second), Number(millisecond)));
  }

  function formatKoreanDateTimeInInjectedPage(date) {
    const pad = (value) => String(value).padStart(2, "0");
    const koreanTime = new Date(date.getTime() + 9 * 60 * 60 * 1000);

    return [
      koreanTime.getUTCFullYear(),
      pad(koreanTime.getUTCMonth() + 1),
      pad(koreanTime.getUTCDate())
    ].join("-") + " " + [
      pad(koreanTime.getUTCHours()),
      pad(koreanTime.getUTCMinutes()),
      pad(koreanTime.getUTCSeconds())
    ].join(":") + `.${String(koreanTime.getUTCMilliseconds()).padStart(3, "0")}`;
  }

  function currentScheduleDate() {
    return new Date(Date.now() + (Number(schedule.timeOffset) || 0));
  }

  const targetTime = parseKoreanDateTimeInInjectedPage(schedule.targetAt).getTime();
  const delay = targetTime - currentScheduleDate().getTime();
  const watchStartDelay = Math.max(0, delay - WATCH_LEAD_TIME_MS);
  const watchDeadline = targetTime + WATCH_TIMEOUT_MS;

  clearTimer();
  clearWatchInterval();
  removeStorageListener();

  if (delay <= 0) {
    writeStatus({
      state: "failed",
      scheduledFor: schedule.targetAt,
      buttonText: schedule.buttonText,
      targetIndex: Number.isInteger(schedule.targetIndex) ? schedule.targetIndex + 1 : undefined,
      selector: schedule.selectedTarget?.selector,
      error: "이미 지난 실행 일시입니다."
    });
    return;
  }

  window.__reservedClickStorageListener = (changes, areaName) => {
    if (areaName !== "local") return;

    const nextStatus = changes[keys.statusKey]?.newValue;
    if (nextStatus?.state === "cancelled") {
      clearTimer();
      clearWatchInterval();
      removeStorageListener();
    }
  };

  chrome.storage.onChanged.addListener(window.__reservedClickStorageListener);

  window.__reservedClickTimerId = window.setTimeout(() => {
    let completed = false;
    window.__reservedClickTimerId = undefined;

    function finish(status) {
      completed = true;
      clearWatchInterval();
      removeStorageListener();
      writeStatus(status);
    }

    function checkAndClick() {
      const target = findSelectedTarget(schedule.selectedTarget);
      const matchedCount = countMatchesForSchedule();
      const now = currentScheduleDate().getTime();

      if (now >= targetTime && isClickable(target)) {
        target.scrollIntoView({ block: "center", inline: "center" });
        target.click();

        finish({
          state: "clicked",
          scheduledFor: schedule.targetAt,
          clickedAt: formatKoreanDateTimeInInjectedPage(currentScheduleDate()),
          buttonText: schedule.buttonText,
          targetIndex: Number.isInteger(schedule.targetIndex) ? schedule.targetIndex + 1 : undefined,
          selector: schedule.selectedTarget?.selector,
          matchedCount
        });
        return;
      }

      if (now > watchDeadline) {
        finish({
          state: "failed",
          scheduledFor: schedule.targetAt,
          clickedAt: formatKoreanDateTimeInInjectedPage(currentScheduleDate()),
          buttonText: schedule.buttonText,
          targetIndex: Number.isInteger(schedule.targetIndex) ? schedule.targetIndex + 1 : undefined,
          selector: schedule.selectedTarget?.selector,
          matchedCount,
          error: target ? "선택한 버튼이 클릭 가능한 상태가 되지 않았습니다." : "선택한 버튼을 찾지 못했습니다."
        });
      }
    }

    checkAndClick();

    if (!completed && !window.__reservedClickWatchIntervalId) {
      window.__reservedClickWatchIntervalId = window.setInterval(checkAndClick, WATCH_INTERVAL_MS);
    }
  }, watchStartDelay);
}

function cancelReservedClick() {
  if (window.__reservedClickTimerId) {
    window.clearTimeout(window.__reservedClickTimerId);
    window.__reservedClickTimerId = undefined;
  }

  if (window.__reservedClickWatchIntervalId) {
    window.clearInterval(window.__reservedClickWatchIntervalId);
    window.__reservedClickWatchIntervalId = undefined;
  }

  if (window.__reservedClickStorageListener) {
    chrome.storage.onChanged.removeListener(window.__reservedClickStorageListener);
    window.__reservedClickStorageListener = undefined;
  }
}

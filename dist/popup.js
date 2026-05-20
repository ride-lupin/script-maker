const STATUS_KEY = "reservedClickStatus";
const SCHEDULE_KEY = "reservedClickSchedule";
const SELECTED_TARGET_KEY = "reservedClickSelectedTarget";
const TARGET_MODE_KEY = "reservedClickTargetMode";

const form = document.querySelector("#schedule-form");
const targetDateInput = document.querySelector("#target-date");
const targetTimeInput = document.querySelector("#target-time");
const targetModeInputs = Array.from(document.querySelectorAll("input[name='targetMode']"));
const textModeFields = document.querySelector("#text-mode-fields");
const selectedModeFields = document.querySelector("#selected-mode-fields");
const buttonTextInput = document.querySelector("#button-text");
const targetIndexInput = document.querySelector("#target-index");
const selectButton = document.querySelector("#select-button");
const selectedTarget = document.querySelector("#selected-target");
const cancelButton = document.querySelector("#cancel-button");
const statusList = document.querySelector("#status-list");

document.addEventListener("DOMContentLoaded", restoreState);
form.addEventListener("submit", scheduleClick);
selectButton.addEventListener("click", startBrowserSelection);
cancelButton.addEventListener("click", cancelSchedule);
targetModeInputs.forEach((input) => input.addEventListener("change", persistTargetMode));
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes[STATUS_KEY]?.newValue) {
    renderStatus(changes[STATUS_KEY].newValue);
  }

  if (changes[SELECTED_TARGET_KEY]) {
    renderSelectedTarget(changes[SELECTED_TARGET_KEY].newValue);
  }

  if (changes[TARGET_MODE_KEY]?.newValue) {
    setTargetMode(changes[TARGET_MODE_KEY].newValue);
  }
});

async function restoreState() {
  const {
    [STATUS_KEY]: status,
    [SCHEDULE_KEY]: schedule,
    [SELECTED_TARGET_KEY]: selected,
    [TARGET_MODE_KEY]: targetMode
  } = await chrome.storage.local.get([STATUS_KEY, SCHEDULE_KEY, SELECTED_TARGET_KEY, TARGET_MODE_KEY]);

  if (schedule) {
    restoreDateTime(schedule.targetAt);
    buttonTextInput.value = schedule.buttonText ?? "";
    targetIndexInput.value = Number.isInteger(schedule.targetIndex) ? String(schedule.targetIndex + 1) : "1";
    setTargetMode(schedule.mode ?? "text");
  } else {
    setDefaultDateTime();
    setTargetMode(targetMode ?? status?.mode ?? "text");
  }

  renderSelectedTarget(selected);
  updateModeFields();
  renderStatus(status ?? { state: "idle" });
}

async function scheduleClick(event) {
  event.preventDefault();

  const targetAt = buildTargetAt();
  const mode = getTargetMode();
  const targetDate = parseLocalDateTime(targetAt);

  if (!targetDate) {
    await saveFailure({ targetAt, error: "날짜와 시간을 선택해야 합니다." });
    return;
  }

  if (targetDate.getTime() <= Date.now()) {
    await saveFailure({ targetAt, error: "이미 지난 실행 일시입니다." });
    return;
  }

  const schedule = await buildSchedule(targetAt, mode);
  if (!schedule.ok) {
    await saveFailure({ targetAt, ...schedule.status, error: schedule.error });
    return;
  }

  const clickSchedule = schedule.value;

  const status = {
    state: "scheduled",
    scheduledFor: targetAt,
    mode: clickSchedule.mode,
    buttonText: clickSchedule.buttonText,
    targetIndex: Number.isInteger(clickSchedule.targetIndex) ? clickSchedule.targetIndex + 1 : undefined,
    selector: clickSchedule.selectedTarget?.selector
  };

  await chrome.storage.local.set({
    [SCHEDULE_KEY]: clickSchedule,
    [STATUS_KEY]: status,
    [TARGET_MODE_KEY]: clickSchedule.mode
  });

  renderStatus(status);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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

async function buildSchedule(targetAt, mode) {
  if (mode === "selected") {
    const { [SELECTED_TARGET_KEY]: selected } = await chrome.storage.local.get(SELECTED_TARGET_KEY);

    if (!selected?.selector) {
      return {
        ok: false,
        error: "브라우저에서 클릭할 버튼을 먼저 선택해야 합니다.",
        status: { mode: "selected" }
      };
    }

    return {
      ok: true,
      value: {
        mode: "selected",
        targetAt,
        buttonText: selected.buttonText ?? "",
        targetIndex: Number.isInteger(selected.targetIndex) ? selected.targetIndex : undefined,
        selectedTarget: selected
      }
    };
  }

  const buttonText = buttonTextInput.value.trim();
  const displayIndex = Number.parseInt(targetIndexInput.value, 10);

  if (!buttonText) {
    return {
      ok: false,
      error: "버튼명을 입력해야 합니다.",
      status: { mode: "text", buttonText, targetIndex: displayIndex }
    };
  }

  if (!Number.isInteger(displayIndex) || displayIndex < 1) {
    return {
      ok: false,
      error: "버튼 순번은 1 이상의 정수여야 합니다.",
      status: { mode: "text", buttonText, targetIndex: displayIndex }
    };
  }

  return {
    ok: true,
    value: {
      mode: "text",
      targetAt,
      buttonText,
      targetIndex: displayIndex - 1
    }
  };
}

async function startBrowserSelection() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("현재 탭을 찾을 수 없습니다.");

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: installButtonPicker,
      args: [{ selectedTargetKey: SELECTED_TARGET_KEY, statusKey: STATUS_KEY, targetModeKey: TARGET_MODE_KEY }]
    });

    await chrome.storage.local.set({ [TARGET_MODE_KEY]: "selected" });
    renderSelectedTarget({ label: "페이지에서 버튼을 선택하세요." });
  } catch (error) {
    await saveFailure({ mode: "selected", error: toMessage(error) });
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
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: cancelReservedClick
    });
  } catch {
    // Storage state is already cancelled; injection failure does not change the user-visible result.
  }
}

async function saveFailure({ targetAt, mode, buttonText, targetIndex, selector, error }) {
  const status = {
    state: "failed",
    scheduledFor: targetAt || undefined,
    mode,
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
    ["선택 방식", formatMode(status.mode)],
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

function getTargetMode() {
  return targetModeInputs.find((input) => input.checked)?.value ?? "text";
}

function setTargetMode(mode) {
  const normalizedMode = mode === "selected" ? "selected" : "text";
  targetModeInputs.forEach((input) => {
    input.checked = input.value === normalizedMode;
  });
  updateModeFields();
}

function updateModeFields() {
  const mode = getTargetMode();
  textModeFields.classList.toggle("hidden", mode !== "text");
  selectedModeFields.classList.toggle("hidden", mode !== "selected");
}

async function persistTargetMode() {
  const mode = getTargetMode();
  updateModeFields();
  await chrome.storage.local.set({ [TARGET_MODE_KEY]: mode });
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

function formatMode(mode) {
  if (mode === "selected") return "브라우저에서 선택";
  if (mode === "text") return "버튼명과 순번";
  return undefined;
}

function buildTargetAt() {
  const date = targetDateInput.value.trim();
  const time = normalizeTimeValue(targetTimeInput.value.trim());

  if (!date || !time) return "";
  return `${date} ${time}`;
}

function setDefaultDateTime() {
  if (targetDateInput.value && targetTimeInput.value) return;

  const now = new Date();
  targetDateInput.value ||= formatDateInput(now);
  targetTimeInput.value ||= formatTimeInput(now);
}

function restoreDateTime(targetAt) {
  if (typeof targetAt !== "string") return;

  const match = targetAt.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::(\d{2}))?$/);
  if (!match) return;

  targetDateInput.value = match[1];
  targetTimeInput.value = `${match[2]}:${match[3] ?? "00"}`;
}

function normalizeTimeValue(value) {
  if (/^\d{2}:\d{2}$/.test(value)) return `${value}:00`;
  if (/^\d{2}:\d{2}:\d{2}$/.test(value)) return value;
  return "";
}

function formatDateInput(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-");
}

function formatTimeInput(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(":");
}

function parseLocalDateTime(value) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match.map(Number);
  const date = new Date(year, month - 1, day, hour, minute, second);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
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
      [keys.targetModeKey]: "selected",
      [keys.statusKey]: {
        state: "idle",
        mode: "selected",
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
  function clearTimer() {
    if (window.__reservedClickTimerId) {
      window.clearTimeout(window.__reservedClickTimerId);
      window.__reservedClickTimerId = undefined;
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

  function countMatchesForSchedule() {
    if (schedule.mode === "selected" && schedule.selectedTarget?.buttonText) {
      return findCandidates(schedule.selectedTarget.buttonText).length;
    }

    return findCandidates(schedule.buttonText).length;
  }

  function writeStatus(status) {
    chrome.storage.local.set({ [keys.statusKey]: status });

    if (status.state !== "scheduled") {
      chrome.storage.local.remove(keys.scheduleKey);
    }
  }

  function parseLocalDateTimeInInjectedPage(value) {
    const [, year, month, day, hour, minute, second] = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/).map(Number);
    return new Date(year, month - 1, day, hour, minute, second);
  }

  function formatLocalDateTimeInInjectedPage(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join("-") + " " + [
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds())
    ].join(":");
  }

  const targetTime = parseLocalDateTimeInInjectedPage(schedule.targetAt).getTime();
  const delay = targetTime - Date.now();

  clearTimer();
  removeStorageListener();

  if (delay <= 0) {
    writeStatus({
      state: "failed",
      scheduledFor: schedule.targetAt,
      mode: schedule.mode,
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
      removeStorageListener();
    }
  };

  chrome.storage.onChanged.addListener(window.__reservedClickStorageListener);

  window.__reservedClickTimerId = window.setTimeout(() => {
    removeStorageListener();
    const candidates = schedule.mode === "selected" ? [] : findCandidates(schedule.buttonText);
    const target = schedule.mode === "selected"
      ? findSelectedTarget(schedule.selectedTarget)
      : candidates[schedule.targetIndex];
    const matchedCount = schedule.mode === "selected" ? countMatchesForSchedule() : candidates.length;

    if (!target) {
      writeStatus({
        state: "failed",
        scheduledFor: schedule.targetAt,
        clickedAt: formatLocalDateTimeInInjectedPage(new Date()),
        mode: schedule.mode,
        buttonText: schedule.buttonText,
        targetIndex: Number.isInteger(schedule.targetIndex) ? schedule.targetIndex + 1 : undefined,
        selector: schedule.selectedTarget?.selector,
        matchedCount,
        error: "지정한 버튼명과 순번에 해당하는 요소를 찾지 못했습니다."
      });
      return;
    }

    target.scrollIntoView({ block: "center", inline: "center" });
    target.click();

    writeStatus({
      state: "clicked",
      scheduledFor: schedule.targetAt,
      clickedAt: formatLocalDateTimeInInjectedPage(new Date()),
      mode: schedule.mode,
      buttonText: schedule.buttonText,
      targetIndex: Number.isInteger(schedule.targetIndex) ? schedule.targetIndex + 1 : undefined,
      selector: schedule.selectedTarget?.selector,
      matchedCount
    });
  }, delay);
}

function cancelReservedClick() {
  if (window.__reservedClickTimerId) {
    window.clearTimeout(window.__reservedClickTimerId);
    window.__reservedClickTimerId = undefined;
  }

  if (window.__reservedClickStorageListener) {
    chrome.storage.onChanged.removeListener(window.__reservedClickStorageListener);
    window.__reservedClickStorageListener = undefined;
  }
}

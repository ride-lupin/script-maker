const STATUS_KEY = "reservedClickStatus";
const SCHEDULE_KEY = "reservedClickSchedule";

const form = document.querySelector("#schedule-form");
const targetDateInput = document.querySelector("#target-date");
const targetTimeInput = document.querySelector("#target-time");
const buttonTextInput = document.querySelector("#button-text");
const targetIndexInput = document.querySelector("#target-index");
const cancelButton = document.querySelector("#cancel-button");
const statusList = document.querySelector("#status-list");

document.addEventListener("DOMContentLoaded", restoreState);
form.addEventListener("submit", scheduleClick);
cancelButton.addEventListener("click", cancelSchedule);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STATUS_KEY]?.newValue) return;
  renderStatus(changes[STATUS_KEY].newValue);
});

async function restoreState() {
  const { [STATUS_KEY]: status, [SCHEDULE_KEY]: schedule } = await chrome.storage.local.get([STATUS_KEY, SCHEDULE_KEY]);

  if (schedule) {
    restoreDateTime(schedule.targetAt);
    buttonTextInput.value = schedule.buttonText ?? "";
    targetIndexInput.value = Number.isInteger(schedule.targetIndex) ? String(schedule.targetIndex + 1) : "1";
  }

  renderStatus(status ?? { state: "idle" });
}

async function scheduleClick(event) {
  event.preventDefault();

  const targetAt = buildTargetAt();
  const buttonText = buttonTextInput.value.trim();
  const displayIndex = Number.parseInt(targetIndexInput.value, 10);
  const targetDate = parseLocalDateTime(targetAt);

  if (!targetDate) {
    await saveFailure(targetAt, buttonText, displayIndex, "날짜와 시간을 선택해야 합니다.");
    return;
  }

  if (targetDate.getTime() <= Date.now()) {
    await saveFailure(targetAt, buttonText, displayIndex, "이미 지난 실행 일시입니다.");
    return;
  }

  if (!buttonText) {
    await saveFailure(targetAt, buttonText, displayIndex, "버튼명을 입력해야 합니다.");
    return;
  }

  if (!Number.isInteger(displayIndex) || displayIndex < 1) {
    await saveFailure(targetAt, buttonText, displayIndex, "버튼 순번은 1 이상의 정수여야 합니다.");
    return;
  }

  const schedule = {
    targetAt,
    buttonText,
    targetIndex: displayIndex - 1
  };

  const status = {
    state: "scheduled",
    scheduledFor: targetAt,
    buttonText,
    targetIndex: displayIndex
  };

  await chrome.storage.local.set({
    [SCHEDULE_KEY]: schedule,
    [STATUS_KEY]: status
  });

  renderStatus(status);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("현재 탭을 찾을 수 없습니다.");

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: installReservedClick,
      args: [schedule, { statusKey: STATUS_KEY, scheduleKey: SCHEDULE_KEY }]
    });
  } catch (error) {
    await saveFailure(targetAt, buttonText, displayIndex, toMessage(error));
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

async function saveFailure(targetAt, buttonText, targetIndex, error) {
  const status = {
    state: "failed",
    scheduledFor: targetAt || undefined,
    buttonText: buttonText || undefined,
    targetIndex: Number.isInteger(targetIndex) ? targetIndex : undefined,
    error
  };

  await chrome.storage.local.set({ [STATUS_KEY]: status });
  renderStatus(status);
}

function renderStatus(status) {
  const rows = [
    ["결과", status.state ?? "idle"],
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
    description.textContent = String(value);

    return [term, description];
  }));
}

function buildTargetAt() {
  const date = targetDateInput.value.trim();
  const time = normalizeTimeValue(targetTimeInput.value.trim());

  if (!date || !time) return "";
  return `${date} ${time}`;
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
      buttonText: schedule.buttonText,
      targetIndex: schedule.targetIndex + 1,
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
    const candidates = findCandidates(schedule.buttonText);
    const target = candidates[schedule.targetIndex];

    if (!target) {
      writeStatus({
        state: "failed",
        scheduledFor: schedule.targetAt,
        clickedAt: formatLocalDateTimeInInjectedPage(new Date()),
        buttonText: schedule.buttonText,
        targetIndex: schedule.targetIndex + 1,
        matchedCount: candidates.length,
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
      buttonText: schedule.buttonText,
      targetIndex: schedule.targetIndex + 1,
      matchedCount: candidates.length
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

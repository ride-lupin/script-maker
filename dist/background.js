const TARGET_CONTEXT_KEY = "reservedClickTargetContext";
const OPEN_COMMAND = "open-reserved-click";

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== OPEN_COMMAND) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || tab.url?.startsWith("chrome-extension://")) return;

  await chrome.storage.local.set({
    [TARGET_CONTEXT_KEY]: {
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      title: tab.title
    }
  });

  await chrome.windows.create({
    url: chrome.runtime.getURL("popup.html?target=stored"),
    type: "popup",
    width: 420,
    height: 640,
    focused: true
  });
});

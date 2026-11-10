// Background entry point (Chrome: service worker, Firefox: event page).
// Listeners are registered synchronously at the top level so the browser can wake
// the script for them after it has been unloaded.
import { api } from './lib/api.js';
import { createGrouper } from './lib/grouper.js';
import { loadConfig } from './lib/storage.js';

const grouper = createGrouper({ api, loadConfig: () => loadConfig(api) });

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (
    changeInfo.url !== undefined ||
    changeInfo.title !== undefined ||
    changeInfo.status === 'complete' ||
    changeInfo.pinned === false
  ) {
    grouper.handleTabChanged(tabId);
  }
});

api.tabs.onRemoved.addListener((tabId) => {
  grouper.handleTabRemoved(tabId);
});

api.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  grouper.handleTabReplaced(addedTabId, removedTabId);
});

api.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') api.runtime.openOptionsPage();
});

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  let work;
  if (message?.type === 'applyAll') {
    work = grouper.applyToAllTabs();
  } else if (message?.type === 'applyTab' && Number.isInteger(message.tabId)) {
    work = grouper.applyToTab(message.tabId).then((outcome) => ({ outcome }));
  } else {
    return false;
  }
  work.then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }),
  );
  return true; // Keep the channel open for the async response.
});

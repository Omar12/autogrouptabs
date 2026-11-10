// Decides which tab group a tab belongs in and moves it there.
// The browser API is injected so this can be exercised with a fake in tests.
import { findMatchingRule, sameTitle } from './rules.js';

const NO_GROUP = -1;
const DECISIONS_KEY = 'decisions';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Chrome rejects tab edits while the user is dragging a tab; those are worth retrying.
const isTransient = (error) => /cannot be edited right now|dragging/i.test(String(error?.message ?? error));

export function createGrouper({ api, loadConfig, retryDelayMs = 200, maxRetries = 6 }) {
  // Everything runs through one queue. Without it, two matching tabs opening at the
  // same moment would each see "no group yet" and create duplicate groups.
  let queue = Promise.resolve();
  const enqueue = (task) => {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  };

  // tabId -> title of the group we last decided on ('' = no rule matched).
  // A tab is only moved when its decision changes, so a tab the user drags out of a
  // group is not yanked back on every title update. Kept in session storage because
  // the background script is unloaded when idle.
  let decisions = null;

  async function getDecisions() {
    if (decisions) return decisions;
    const loaded = new Map();
    try {
      const stored = await api.storage.session?.get(DECISIONS_KEY);
      for (const [tabId, title] of Object.entries(stored?.[DECISIONS_KEY] ?? {})) {
        loaded.set(Number(tabId), title);
      }
    } catch {
      // Session storage unavailable: decisions simply live in memory.
    }
    decisions = loaded;
    return decisions;
  }

  async function persistDecisions() {
    try {
      await api.storage.session?.set({ [DECISIONS_KEY]: Object.fromEntries(decisions) });
    } catch {
      // Non-fatal, see above.
    }
  }

  async function withRetry(operation) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= maxRetries || !isTransient(error)) throw error;
        await sleep(retryDelayMs * (attempt + 1));
      }
    }
  }

  /** @returns {'grouped'|'ungrouped'|'unchanged'|'skipped'} */
  async function evaluate(tabId, force) {
    const config = await loadConfig();
    if (!config.enabled && !force) return 'skipped';

    let tab;
    try {
      tab = await api.tabs.get(tabId);
    } catch {
      return 'skipped'; // Tab was closed in the meantime.
    }
    // Pinned tabs cannot live in a group (grouping would silently unpin them).
    if (!tab || !tab.url || tab.pinned) return 'skipped';

    // While a page loads, its title is still the previous page's or a placeholder.
    const title = tab.status === 'loading' ? null : tab.title ?? '';
    const { rule, pending } = findMatchingRule(config.rules, { url: tab.url, title });
    if (pending) return 'skipped'; // Re-evaluated when loading completes.

    const target = rule ? rule.name.trim() : '';
    const known = await getDecisions();
    const previous = known.get(tabId);
    if (!force && previous !== undefined && sameTitle(previous, target)) return 'unchanged';

    const remember = async () => {
      known.set(tabId, target);
      await persistDecisions();
    };

    if (!rule) {
      let outcome = 'unchanged';
      // Only take a tab out of a group that this extension put it in.
      if (config.ungroupUnmatched && previous && tab.groupId !== undefined && tab.groupId !== NO_GROUP) {
        let group = null;
        try {
          group = await api.tabGroups.get(tab.groupId);
        } catch {
          group = null;
        }
        if (group && sameTitle(group.title, previous)) {
          await withRetry(() => api.tabs.ungroup([tabId]));
          outcome = 'ungrouped';
        }
      }
      await remember();
      return outcome;
    }

    // Tab groups only exist in normal browser windows (not popups, apps or devtools).
    const win = await api.windows.get(tab.windowId);
    if (win.type !== 'normal') return 'skipped';

    const groups = await api.tabGroups.query({ windowId: tab.windowId });
    const existing = groups.find((group) => sameTitle(group.title, target));

    let outcome = 'unchanged';
    if (existing) {
      if (tab.groupId !== existing.id) {
        await withRetry(() => api.tabs.group({ tabIds: [tabId], groupId: existing.id }));
        outcome = 'grouped';
      }
    } else {
      // windowId is explicit: the default is the *focused* window, which would drag
      // a background-window tab across windows.
      const groupId = await withRetry(() =>
        api.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } }),
      );
      await withRetry(() => api.tabGroups.update(groupId, { title: target, color: rule.color }));
      outcome = 'grouped';
    }
    await remember();
    return outcome;
  }

  async function safeEvaluate(tabId, force) {
    try {
      return await evaluate(tabId, force);
    } catch (error) {
      // Typically the tab or window vanished mid-operation. Never break the queue.
      console.warn('Auto Group Tabs: could not group tab', tabId, error);
      return 'skipped';
    }
  }

  return {
    /** A tab's URL/title/loading state changed: regroup it if its matching rule changed. */
    handleTabChanged(tabId) {
      return enqueue(() => safeEvaluate(tabId, false));
    },

    /** Explicit user request for one tab: applies even when paused or already decided. */
    applyToTab(tabId) {
      return enqueue(() => safeEvaluate(tabId, true));
    },

    /** Explicit user request: run the rules over every open tab. */
    async applyToAllTabs() {
      const tabs = await api.tabs.query({});
      let moved = 0;
      for (const tab of tabs) {
        const outcome = await enqueue(() => safeEvaluate(tab.id, true));
        if (outcome === 'grouped' || outcome === 'ungrouped') moved += 1;
      }
      return { moved, total: tabs.length };
    },

    handleTabRemoved(tabId) {
      return enqueue(async () => {
        const known = await getDecisions();
        if (known.delete(tabId)) await persistDecisions();
      });
    },

    /** The browser swapped a tab for another (e.g. prerender): keep its decision. */
    handleTabReplaced(addedTabId, removedTabId) {
      return enqueue(async () => {
        const known = await getDecisions();
        if (!known.has(removedTabId)) return;
        known.set(addedTabId, known.get(removedTabId));
        known.delete(removedTabId);
        await persistDecisions();
      });
    },
  };
}

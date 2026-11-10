import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGrouper } from '../src/lib/grouper.js';
import { createRule, normalizeConfig } from '../src/lib/rules.js';

const cond = (field, operator, value) => ({ field, operator, value });
const shopping = () => createRule({ name: 'Shopping', color: 'green', conditions: [cond('domain', 'domain', 'amazon.com')] });

/** Minimal in-memory stand-in for the tabs / tabGroups / windows / storage.session APIs. */
function createFakeBrowser() {
  const state = { tabs: new Map(), groups: new Map(), windows: new Map([[1, { id: 1, type: 'normal' }]]), nextGroupId: 100, session: {}, calls: [], failGroupTimes: 0 };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const dropEmptyGroups = () => {
    for (const id of state.groups.keys()) {
      if (![...state.tabs.values()].some((tab) => tab.groupId === id)) state.groups.delete(id);
    }
  };
  const api = {
    tabs: {
      async get(id) {
        await tick();
        if (!state.tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
        return { ...state.tabs.get(id) };
      },
      async query() {
        return [...state.tabs.values()].map((tab) => ({ ...tab }));
      },
      async group({ tabIds, groupId, createProperties }) {
        await tick();
        state.calls.push({ op: 'group', tabIds, groupId, createProperties });
        if (state.failGroupTimes > 0) {
          state.failGroupTimes -= 1;
          throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
        }
        let id = groupId;
        if (id === undefined) {
          id = state.nextGroupId++;
          state.groups.set(id, { id, title: '', color: 'grey', windowId: createProperties.windowId });
        } else if (!state.groups.has(id)) {
          throw new Error(`No group with id: ${id}.`);
        }
        for (const tabId of tabIds) {
          const tab = state.tabs.get(tabId);
          tab.groupId = id;
          tab.windowId = state.groups.get(id).windowId;
        }
        dropEmptyGroups();
        return id;
      },
      async ungroup(tabIds) {
        await tick();
        state.calls.push({ op: 'ungroup', tabIds });
        for (const tabId of tabIds) state.tabs.get(tabId).groupId = -1;
        dropEmptyGroups();
      },
    },
    tabGroups: {
      async get(id) {
        if (!state.groups.has(id)) throw new Error(`No group with id: ${id}.`);
        return { ...state.groups.get(id) };
      },
      async query({ windowId }) {
        await tick();
        return [...state.groups.values()].filter((group) => group.windowId === windowId).map((group) => ({ ...group }));
      },
      async update(id, props) {
        await tick();
        Object.assign(state.groups.get(id), props);
        return { ...state.groups.get(id) };
      },
    },
    windows: {
      async get(id) {
        return { ...state.windows.get(id) };
      },
    },
    storage: {
      session: {
        async get(key) {
          return key in state.session ? { [key]: structuredClone(state.session[key]) } : {};
        },
        async set(items) {
          Object.assign(state.session, structuredClone(items));
        },
      },
    },
  };
  const addTab = (id, url, extra = {}) => {
    state.tabs.set(id, { id, url, title: '', status: 'complete', pinned: false, groupId: -1, windowId: 1, ...extra });
  };
  return { api, state, addTab };
}

function setup(configInput) {
  const fake = createFakeBrowser();
  const holder = { config: normalizeConfig(configInput) };
  const grouper = createGrouper({ api: fake.api, loadConfig: async () => holder.config, retryDelayMs: 1 });
  const groupTitleOf = (tabId) => fake.state.groups.get(fake.state.tabs.get(tabId).groupId)?.title ?? null;
  return { ...fake, grouper, holder, groupTitleOf };
}

test('creates the named group when it does not exist, with the rule colour', async () => {
  const t = setup({ rules: [shopping()] });
  t.addTab(1, 'https://www.amazon.com/');
  assert.equal(await t.grouper.handleTabChanged(1), 'grouped');
  assert.equal(t.groupTitleOf(1), 'Shopping');
  assert.equal([...t.state.groups.values()][0].color, 'green');
  assert.deepEqual(t.state.calls[0].createProperties, { windowId: 1 });
});

test('adds to an existing group with that name (case-insensitive) instead of creating another', async () => {
  const t = setup({ rules: [shopping()] });
  t.state.groups.set(7, { id: 7, title: ' shopping', color: 'red', windowId: 1 });
  t.addTab(9, 'https://example.com/', { groupId: 7 });
  t.addTab(1, 'https://amazon.com/x');
  await t.grouper.handleTabChanged(1);
  assert.equal(t.state.tabs.get(1).groupId, 7);
  assert.equal(t.state.groups.size, 1);
  assert.equal(t.state.groups.get(7).color, 'red', 'existing group is left as the user styled it');
});

test('tabs opening at the same moment end up in one group, not duplicates', async () => {
  const t = setup({ rules: [shopping()] });
  for (let id = 1; id <= 5; id += 1) t.addTab(id, `https://amazon.com/${id}`);
  await Promise.all([1, 2, 3, 4, 5].map((id) => t.grouper.handleTabChanged(id)));
  assert.equal(t.state.groups.size, 1);
  assert.deepEqual(new Set([1, 2, 3, 4, 5].map((id) => t.state.tabs.get(id).groupId)).size, 1);
});

test('groups are per window', async () => {
  const t = setup({ rules: [shopping()] });
  t.state.windows.set(2, { id: 2, type: 'normal' });
  t.addTab(1, 'https://amazon.com/1');
  t.addTab(2, 'https://amazon.com/2', { windowId: 2 });
  await t.grouper.handleTabChanged(1);
  await t.grouper.handleTabChanged(2);
  assert.equal(t.state.tabs.get(1).windowId, 1);
  assert.equal(t.state.tabs.get(2).windowId, 2);
  assert.equal(t.state.groups.size, 2);
});

test('leaves unmatched, pinned, popup-window and closed tabs alone', async () => {
  const t = setup({ rules: [shopping()] });
  t.state.windows.set(3, { id: 3, type: 'popup' });
  t.addTab(1, 'https://example.com/');
  t.addTab(2, 'https://amazon.com/', { pinned: true });
  t.addTab(3, 'https://amazon.com/', { windowId: 3 });
  for (const id of [1, 2, 3, 404]) await t.grouper.handleTabChanged(id);
  assert.equal(t.state.calls.length, 0);
});

test('does nothing when paused, but an explicit apply still works', async () => {
  const t = setup({ enabled: false, rules: [shopping()] });
  t.addTab(1, 'https://amazon.com/');
  assert.equal(await t.grouper.handleTabChanged(1), 'skipped');
  assert.equal(t.groupTitleOf(1), null);
  assert.equal(await t.grouper.applyToTab(1), 'grouped');
  assert.equal(t.groupTitleOf(1), 'Shopping');
});

test('a tab the user dragged out of its group is not pulled back by later updates', async () => {
  const t = setup({ rules: [shopping()] });
  t.addTab(1, 'https://amazon.com/a');
  t.addTab(2, 'https://amazon.com/b');
  await t.grouper.handleTabChanged(1);
  await t.grouper.handleTabChanged(2);
  t.state.tabs.get(1).groupId = -1; // user drags it out
  t.state.tabs.get(1).title = 'New title';
  assert.equal(await t.grouper.handleTabChanged(1), 'unchanged');
  assert.equal(t.state.tabs.get(1).groupId, -1);
  // ...but "Group open tabs now" puts it back.
  assert.deepEqual(await t.grouper.applyToAllTabs(), { moved: 1, total: 2 });
  assert.equal(t.groupTitleOf(1), 'Shopping');
});

test('decisions survive the background script being unloaded', async () => {
  const t = setup({ rules: [shopping()] });
  t.addTab(1, 'https://amazon.com/a');
  await t.grouper.handleTabChanged(1);
  t.state.tabs.get(1).groupId = -1;
  const revived = createGrouper({ api: t.api, loadConfig: async () => t.holder.config });
  assert.equal(await revived.handleTabChanged(1), 'unchanged');
});

test('moves a tab between groups when it navigates to a site with another rule', async () => {
  const work = createRule({ name: 'Work', conditions: [cond('domain', 'domain', 'github.com')] });
  const t = setup({ rules: [shopping(), work] });
  t.addTab(1, 'https://amazon.com/');
  await t.grouper.handleTabChanged(1);
  t.state.tabs.get(1).url = 'https://github.com/';
  assert.equal(await t.grouper.handleTabChanged(1), 'grouped');
  assert.equal(t.groupTitleOf(1), 'Work');
  assert.equal(t.state.groups.size, 1, 'emptied Shopping group is gone');
});

test('unmatched tabs stay grouped by default and are ungrouped only when the option is on', async () => {
  const t = setup({ rules: [shopping()] });
  t.addTab(1, 'https://amazon.com/');
  await t.grouper.handleTabChanged(1);
  t.state.tabs.get(1).url = 'https://example.com/';
  assert.equal(await t.grouper.handleTabChanged(1), 'unchanged');
  assert.equal(t.groupTitleOf(1), 'Shopping');

  const u = setup({ ungroupUnmatched: true, rules: [shopping()] });
  u.addTab(1, 'https://amazon.com/');
  await u.grouper.handleTabChanged(1);
  u.state.tabs.get(1).url = 'https://example.com/';
  assert.equal(await u.grouper.handleTabChanged(1), 'ungrouped');
  assert.equal(u.state.tabs.get(1).groupId, -1);
});

test('ungroup option never touches tabs the extension did not group', async () => {
  const t = setup({ ungroupUnmatched: true, rules: [shopping()] });
  t.state.groups.set(7, { id: 7, title: 'Shopping', color: 'red', windowId: 1 });
  t.addTab(1, 'https://example.com/', { groupId: 7 }); // user put it there by hand
  assert.equal(await t.grouper.handleTabChanged(1), 'unchanged');
  assert.deepEqual(await t.grouper.applyToAllTabs(), { moved: 0, total: 1 });
  assert.equal(t.state.tabs.get(1).groupId, 7);

  // Grouped by us, then moved by the user into another group: also left alone.
  t.addTab(2, 'https://amazon.com/');
  await t.grouper.handleTabChanged(2);
  t.state.groups.set(8, { id: 8, title: 'Mine', color: 'red', windowId: 1 });
  Object.assign(t.state.tabs.get(2), { groupId: 8, url: 'https://example.com/' });
  assert.equal(await t.grouper.handleTabChanged(2), 'unchanged');
  assert.equal(t.state.tabs.get(2).groupId, 8);
});

test('title rules wait for the page to finish loading', async () => {
  const docs = createRule({ name: 'Docs', conditions: [cond('title', 'contains', 'docs')] });
  const t = setup({ ungroupUnmatched: true, rules: [docs] });
  t.addTab(1, 'https://a.test/', { status: 'loading', title: 'docs.a.test/placeholder' });
  assert.equal(await t.grouper.handleTabChanged(1), 'skipped');
  assert.equal(t.state.calls.length, 0);
  Object.assign(t.state.tabs.get(1), { status: 'complete', title: 'Budget' });
  assert.equal(await t.grouper.handleTabChanged(1), 'unchanged');
  t.state.tabs.get(1).title = 'API Docs';
  assert.equal(await t.grouper.handleTabChanged(1), 'grouped');
  // Navigating within the site must not bounce the tab out while the new page loads.
  Object.assign(t.state.tabs.get(1), { status: 'loading', url: 'https://a.test/next' });
  assert.equal(await t.grouper.handleTabChanged(1), 'skipped');
  assert.equal(t.groupTitleOf(1), 'Docs');
});

test('retries while the user is dragging a tab', async () => {
  const t = setup({ rules: [shopping()] });
  t.addTab(1, 'https://amazon.com/');
  t.state.failGroupTimes = 3;
  assert.equal(await t.grouper.handleTabChanged(1), 'grouped');
  assert.equal(t.groupTitleOf(1), 'Shopping');
});

test('a failure for one tab does not block the queue', async () => {
  const t = setup({ rules: [shopping()] });
  t.addTab(1, 'https://amazon.com/1');
  t.addTab(2, 'https://amazon.com/2');
  t.state.failGroupTimes = 100;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await t.grouper.handleTabChanged(1), 'skipped');
  } finally {
    console.warn = originalWarn;
  }
  t.state.failGroupTimes = 0;
  assert.equal(await t.grouper.handleTabChanged(2), 'grouped');
  // The failed tab was not recorded as handled, so its next update retries it.
  assert.equal(await t.grouper.handleTabChanged(1), 'grouped');
});

test('closed tabs are forgotten and replaced tabs keep their decision', async () => {
  const t = setup({ rules: [shopping()] });
  t.addTab(1, 'https://amazon.com/');
  await t.grouper.handleTabChanged(1);
  await t.grouper.handleTabReplaced(2, 1);
  assert.deepEqual(t.state.session.decisions, { 2: 'Shopping' });
  await t.grouper.handleTabRemoved(2);
  assert.deepEqual(t.state.session.decisions, {});
});

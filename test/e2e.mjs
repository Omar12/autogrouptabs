// End-to-end check in real Chromium: loads dist/chrome, drives real tabs, and reads
// real tab groups back. Requires Playwright + Chromium (dev only). Run: npm run test:e2e
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const extensionPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'chrome');

// Every hostname is mapped to this local server; ?title= sets the page title.
const server = createServer((req, res) => {
  const title = new URL(req.url, 'http://x').searchParams.get('title') ?? 'Untitled page';
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><title>${title}</title><h1>${req.headers.host}</h1>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const site = (host, path = '/') => `http://${host}:${port}${path}`;

const profile = await mkdtemp(join(tmpdir(), 'agt-e2e-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [
    '--headless=new',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    `--host-resolver-rules=MAP * 127.0.0.1`,
  ],
});

let failed = false;
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const errors = [];

  // Snapshot of {groupTitle: [hostnames...]} via the real extension APIs.
  const snapshot = () =>
    worker.evaluate(async () => {
      const groups = await chrome.tabGroups.query({});
      const tabs = await chrome.tabs.query({});
      const result = { ungrouped: [] };
      for (const group of groups) result[`${group.title}|${group.color}`] = [];
      for (const tab of tabs) {
        if (!/^http/.test(tab.url)) continue;
        const group = groups.find((g) => g.id === tab.groupId);
        result[group ? `${group.title}|${group.color}` : 'ungrouped'].push(new URL(tab.url).hostname);
      }
      for (const key of Object.keys(result)) result[key].sort();
      return result;
    });
  const expectGroups = async (expected, label) => {
    let actual;
    for (let i = 0; i < 50; i += 1) {
      actual = await snapshot();
      try {
        assert.deepEqual(actual, expected);
        console.log(`ok - ${label}`);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.deepEqual(actual, expected, label);
  };
  const open = async (url) => {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(url);
    return page;
  };

  // --- Options page: create the example rule through the real UI ---
  const options = await open(`chrome-extension://${extensionId}/options/options.html`);
  options.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await options.click('#add-rule');
  await options.fill('.rule-name', 'Shopping');
  await options.fill('.condition .value', 'Amazon.com');
  await options.check('.swatch input[aria-label="green"]');
  // Second rule: custom set (all of: domain + title).
  await options.click('#add-rule');
  await options.locator('.rule').nth(1).locator('.rule-name').fill('Work');
  await options.locator('.rule').nth(1).locator('select[aria-label="How conditions combine"]').selectOption('all');
  await options.locator('.rule').nth(1).locator('.value').fill('github.com');
  await options.locator('.rule').nth(1).locator('.add-condition').click();
  const second = options.locator('.rule').nth(1).locator('.condition').nth(1);
  await second.locator('select[aria-label="What to match"]').selectOption('title');
  await second.locator('.value').fill('pull request');
  // Third rule: title only.
  await options.click('#add-rule');
  await options.locator('.rule').nth(2).locator('.rule-name').fill('Reading');
  await options.locator('.rule').nth(2).locator('select[aria-label="What to match"]').selectOption('title');
  await options.locator('.rule').nth(2).locator('.value').fill('article');
  await options.waitForFunction(() => document.getElementById('save-status').textContent === 'Saved');
  await options.waitForTimeout(400);

  const stored = await worker.evaluate(async () => (await chrome.storage.local.get('config')).config);
  assert.equal(stored.rules.length, 3);
  assert.deepEqual(
    stored.rules.map((r) => [r.name, r.color, r.matchMode, r.conditions.map((c) => `${c.field} ${c.operator} ${c.value}`)]),
    [
      ['Shopping', 'green', 'any', ['domain domain Amazon.com']],
      ['Work', 'blue', 'all', ['domain domain github.com', 'title contains pull request']],
      ['Reading', 'blue', 'any', ['title contains article']],
    ],
  );
  console.log('ok - rules created through the options page are stored');

  await options.fill('#test-url', 'www.amazon.com/deals');
  assert.match(await options.textContent('#test-result'), /Shopping.*rule 1/);
  await options.fill('#test-url', 'example.org');
  assert.match(await options.textContent('#test-result'), /No rule matches/);
  console.log('ok - rule tester');

  // --- Grouping ---
  await open(site('www.amazon.com'));
  await expectGroups({ ungrouped: [], 'Shopping|green': ['www.amazon.com'] }, 'creates the Shopping group for amazon.com');

  await Promise.all([open(site('amazon.com', '/a')), open(site('smile.amazon.com')), open(site('example.org'))]);
  await expectGroups(
    { ungrouped: ['example.org'], 'Shopping|green': ['amazon.com', 'smile.amazon.com', 'www.amazon.com'] },
    'adds further amazon tabs to the existing group; others untouched',
  );

  await open(site('github.com', '/?title=Home'));
  const pr = await open(site('github.com', '/?title=Pull%20Request%2012'));
  await open(site('news.test', '/?title=Long%20Article'));
  await expectGroups(
    {
      ungrouped: ['example.org', 'github.com'],
      'Shopping|green': ['amazon.com', 'smile.amazon.com', 'www.amazon.com'],
      'Work|blue': ['github.com'],
      'Reading|blue': ['news.test'],
    },
    'custom "all" set and title rules',
  );

  await pr.goto(site('amazon.com', '/from-work'));
  await expectGroups(
    {
      ungrouped: ['example.org', 'github.com'],
      'Shopping|green': ['amazon.com', 'amazon.com', 'smile.amazon.com', 'www.amazon.com'],
      'Reading|blue': ['news.test'],
    },
    'a tab that navigates to another rule moves groups',
  );

  // --- Popup: pause toggle + "Group open tabs now" ---
  const popup = await open(`chrome-extension://${extensionId}/popup/popup.html`);
  popup.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  assert.equal(await popup.isChecked('#enabled'), true);
  await popup.uncheck('#enabled');
  await popup.waitForFunction(() => document.getElementById('state').textContent === 'Paused');
  await open(site('amazon.com', '/while-paused'));
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal((await snapshot()).ungrouped.filter((h) => h === 'amazon.com').length, 1);
  console.log('ok - pausing stops automatic grouping');
  await popup.click('#apply-all');
  await popup.waitForFunction(() => /Moved 1 tab/.test(document.getElementById('status').textContent));
  await expectGroups(
    {
      ungrouped: ['example.org', 'github.com'],
      'Shopping|green': ['amazon.com', 'amazon.com', 'amazon.com', 'smile.amazon.com', 'www.amazon.com'],
      'Reading|blue': ['news.test'],
    },
    '"Group open tabs now" applies rules on demand',
  );

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nAll end-to-end checks passed.');
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

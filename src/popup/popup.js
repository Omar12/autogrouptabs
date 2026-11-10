import { api } from '../lib/api.js';
import { createCondition, createRule, findMatchingRule, getHostname, normalizeDomain, sameTitle } from '../lib/rules.js';
import { loadConfig, saveConfig } from '../lib/storage.js';

const $ = (id) => document.getElementById(id);

let config = await loadConfig(api);
const [activeTab] = await api.tabs.query({ active: true, currentWindow: true });

// Quick-add is offered for ordinary web pages only.
const isWebPage = /^https?:/i.test(activeTab?.url ?? '');
const domain = isWebPage ? getHostname(activeTab.url).replace(/^www\./, '') : '';

function renderState() {
  $('enabled').checked = config.enabled;
  $('state').textContent = config.enabled ? 'Grouping tabs automatically' : 'Paused';

  if (activeTab?.url) {
    const { rule } = findMatchingRule(config.rules, { url: activeTab.url, title: activeTab.title ?? '' });
    $('current').hidden = false;
    $('current-match').textContent = rule ? `Matches “${rule.name.trim()}”` : 'No rule matches this tab';
  }

  const names = [];
  for (const rule of config.rules) {
    const name = rule.name.trim();
    if (name && !names.some((existing) => sameTitle(existing, name))) names.push(name);
  }
  $('group-names').replaceChildren(
    ...names.map((name) => {
      const option = document.createElement('option');
      option.value = name;
      return option;
    }),
  );
}

async function request(message) {
  const response = await api.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? 'No response from the extension.');
  return response;
}

$('enabled').addEventListener('change', async (event) => {
  config = await loadConfig(api);
  config.enabled = event.target.checked;
  config = await saveConfig(api, config);
  renderState();
});

$('quick-add').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('group-name').value.trim();
  if (!name || !domain) return;

  config = await loadConfig(api);
  // Extend an existing "any of" rule for this group when there is one; otherwise add a rule.
  const existing = config.rules.find((rule) => sameTitle(rule.name, name) && rule.matchMode === 'any');
  if (existing) {
    const alreadyThere = existing.conditions.some(
      (condition) =>
        condition.field === 'domain' && condition.operator === 'domain' && normalizeDomain(condition.value) === domain,
    );
    if (!alreadyThere) existing.conditions.push(createCondition('domain', domain));
    existing.enabled = true;
  } else {
    config.rules.push(createRule({ name, conditions: [createCondition('domain', domain)] }));
  }
  config = await saveConfig(api, config);
  renderState();

  try {
    await request({ type: 'applyTab', tabId: activeTab.id });
    $('status').textContent = `${domain} now goes to “${name}”.`;
  } catch (error) {
    $('status').textContent = `Rule saved, but this tab could not be grouped: ${error?.message ?? error}`;
  }
  $('group-name').value = '';
});

$('apply-all').addEventListener('click', async () => {
  $('apply-all').disabled = true;
  $('status').textContent = 'Grouping…';
  try {
    const { moved } = await request({ type: 'applyAll' });
    $('status').textContent = moved === 0 ? 'All tabs were already where they belong.' : `Moved ${moved} tab(s).`;
  } catch (error) {
    $('status').textContent = `Could not group tabs: ${error?.message ?? error}`;
  } finally {
    $('apply-all').disabled = false;
  }
});

$('open-options').addEventListener('click', async () => {
  await api.runtime.openOptionsPage();
  window.close();
});

if (domain) {
  $('domain').textContent = domain;
  $('quick-add').hidden = false;
}
renderState();

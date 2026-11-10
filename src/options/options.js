import { api } from '../lib/api.js';
import {
  FIELDS,
  FIELD_LABELS,
  GROUP_COLORS,
  OPERATORS,
  OPERATOR_LABELS,
  createCondition,
  createRule,
  findMatchingRule,
  getRegex,
  isConditionValid,
  normalizeConfig,
} from '../lib/rules.js';
import { STORAGE_KEY, loadConfig, saveConfig } from '../lib/storage.js';

const VALUE_PLACEHOLDERS = {
  domain: 'amazon.com',
  url: 'e.g. /checkout or docs.google.com/spreadsheets',
  title: 'e.g. Invoice',
};

const $ = (id) => document.getElementById(id);

let config = normalizeConfig(null);
let saveTimer = null;
let lastSavedJson = '';

/** Tiny DOM builder. Text is always set via textContent/properties, never as HTML. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  el.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else if (value !== false) el.setAttribute(key, value === true ? '' : value);
  }
  return el;
}

// ---------- persistence ----------

function setStatus(id, text, clearAfterMs = 0) {
  const el = $(id);
  el.textContent = text;
  if (clearAfterMs) {
    setTimeout(() => {
      if (el.textContent === text) el.textContent = '';
    }, clearAfterMs);
  }
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    // Recorded before the write so our own storage.onChanged echo is recognised.
    lastSavedJson = JSON.stringify(normalizeConfig(config));
    await saveConfig(api, config);
    setStatus('save-status', 'Saved', 1500);
  } catch (error) {
    setStatus('save-status', `Could not save: ${error?.message ?? error}`);
  }
}

/** Debounced save for typing; structural changes call saveNow() directly. */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
  updateTestResult();
}

function commit() {
  updateTestResult();
  return saveNow();
}

// ---------- rule list ----------

function ruleProblem(rule) {
  if (!rule.name.trim()) return 'Give this rule a tab group name — it is inactive until it has one.';
  if (!rule.conditions.some(isConditionValid)) {
    return 'Add at least one condition with a value — this rule is inactive until it has one.';
  }
  const badRegex = rule.conditions.some(
    (condition) => condition.operator === 'regex' && condition.value.trim() && !getRegex(condition.value.trim()),
  );
  if (badRegex) return 'One of the regular expressions is invalid and is being ignored.';
  const incomplete = rule.conditions.some((condition) => !isConditionValid(condition));
  if (incomplete) return 'Conditions without a usable value are ignored.';
  return '';
}

function refreshRuleState(rule, card) {
  card.classList.toggle('disabled', !rule.enabled);
  card.style.setProperty('--rule-color', `var(--group-${rule.color})`);
  const problem = ruleProblem(rule);
  const hint = card.querySelector('.hint');
  hint.textContent = problem;
  hint.hidden = !problem;
  card.querySelectorAll('.condition').forEach((row, index) => {
    const condition = rule.conditions[index];
    const invalidRegex =
      condition.operator === 'regex' && condition.value.trim() !== '' && !getRegex(condition.value.trim());
    row.querySelector('.value').setAttribute('aria-invalid', String(invalidRegex));
  });
}

function renderCondition(rule, condition, index, card) {
  const key = `${rule.id}:${index}`;
  return h(
    'div',
    { class: 'condition' },
    h(
      'select',
      {
        'aria-label': 'What to match',
        dataset: { key: `${key}:field` },
        value: condition.field,
        onchange: (event) => {
          condition.field = event.target.value;
          condition.operator = OPERATORS[condition.field][0];
          render();
          commit();
        },
      },
      FIELDS.map((field) => h('option', { value: field }, FIELD_LABELS[field])),
    ),
    h(
      'select',
      {
        'aria-label': 'How to match',
        dataset: { key: `${key}:operator` },
        value: condition.operator,
        onchange: (event) => {
          condition.operator = event.target.value;
          refreshRuleState(rule, card());
          commit();
        },
      },
      OPERATORS[condition.field].map((operator) => h('option', { value: operator }, OPERATOR_LABELS[operator])),
    ),
    h('input', {
      type: 'text',
      class: 'value',
      'aria-label': 'Value to match',
      spellcheck: false,
      placeholder: condition.operator === 'regex' ? 'regular expression' : VALUE_PLACEHOLDERS[condition.field],
      dataset: { key: `${key}:value` },
      value: condition.value,
      oninput: (event) => {
        condition.value = event.target.value;
        refreshRuleState(rule, card());
        scheduleSave();
      },
    }),
    h(
      'button',
      {
        type: 'button',
        class: 'icon',
        title: 'Remove condition',
        'aria-label': 'Remove condition',
        onclick: () => {
          rule.conditions.splice(index, 1);
          render();
          commit();
        },
      },
      '✕',
    ),
  );
}

function renderRule(rule, index) {
  let cardEl;
  const card = () => cardEl;
  const move = (delta) => {
    const target = index + delta;
    if (target < 0 || target >= config.rules.length) return;
    config.rules.splice(index, 1);
    config.rules.splice(target, 0, rule);
    render(`${rule.id}:${delta < 0 ? 'up' : 'down'}`);
    commit();
  };

  cardEl = h(
    'li',
    { class: 'rule' },
    h(
      'div',
      { class: 'rule-head' },
      h('span', { class: 'rule-index' }, `${index + 1}.`),
      h('input', {
        type: 'text',
        class: 'rule-name',
        'aria-label': 'Tab group name',
        placeholder: 'Tab group name, e.g. Shopping',
        maxLength: 100,
        dataset: { key: `${rule.id}:name` },
        value: rule.name,
        oninput: (event) => {
          rule.name = event.target.value;
          refreshRuleState(rule, cardEl);
          scheduleSave();
        },
      }),
      h(
        'div',
        { class: 'swatches', role: 'radiogroup', 'aria-label': 'Group colour' },
        GROUP_COLORS.map((color) =>
          h(
            'label',
            { class: 'swatch', title: color, style: `--swatch: var(--group-${color})` },
            h('input', {
              type: 'radio',
              name: `color-${rule.id}`,
              'aria-label': color,
              checked: rule.color === color,
              dataset: { key: `${rule.id}:color:${color}` },
              onchange: () => {
                rule.color = color;
                refreshRuleState(rule, cardEl);
                commit();
              },
            }),
            h('span'),
          ),
        ),
      ),
      h(
        'div',
        { class: 'rule-tools' },
        h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: rule.enabled,
            dataset: { key: `${rule.id}:enabled` },
            onchange: (event) => {
              rule.enabled = event.target.checked;
              refreshRuleState(rule, cardEl);
              commit();
            },
          }),
          h('span', {}, 'On'),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'icon',
            title: 'Move up (higher priority)',
            'aria-label': 'Move rule up',
            disabled: index === 0,
            dataset: { key: `${rule.id}:up` },
            onclick: () => move(-1),
          },
          '↑',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'icon',
            title: 'Move down (lower priority)',
            'aria-label': 'Move rule down',
            disabled: index === config.rules.length - 1,
            dataset: { key: `${rule.id}:down` },
            onclick: () => move(1),
          },
          '↓',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'danger',
            onclick: () => {
              const hasContent = rule.name.trim() || rule.conditions.some((condition) => condition.value.trim());
              if (hasContent && !confirm(`Delete the rule for "${rule.name.trim() || 'unnamed group'}"?`)) return;
              config.rules.splice(index, 1);
              render();
              commit();
            },
          },
          'Delete',
        ),
      ),
    ),
    h(
      'div',
      { class: 'rule-body' },
      h(
        'div',
        { class: 'mode-row' },
        'Group a tab when',
        h(
          'select',
          {
            class: 'inline',
            'aria-label': 'How conditions combine',
            dataset: { key: `${rule.id}:mode` },
            value: rule.matchMode,
            onchange: (event) => {
              rule.matchMode = event.target.value;
              commit();
            },
          },
          h('option', { value: 'any' }, 'any'),
          h('option', { value: 'all' }, 'all'),
        ),
        'of these match:',
      ),
      h(
        'div',
        { class: 'conditions' },
        rule.conditions.map((condition, conditionIndex) => renderCondition(rule, condition, conditionIndex, card)),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'add-condition',
          onclick: () => {
            rule.conditions.push(createCondition());
            render(`${rule.id}:${rule.conditions.length - 1}:value`);
            commit();
          },
        },
        '+ Add condition',
      ),
      h('p', { class: 'hint', hidden: true }),
    ),
  );
  refreshRuleState(rule, cardEl);
  return cardEl;
}

/** Rebuilds the rule list, keeping (or moving) keyboard focus. */
function render(focusKey = document.activeElement?.dataset?.key) {
  $('enabled').checked = config.enabled;
  $('ungroup-unmatched').checked = config.ungroupUnmatched;
  $('rules').replaceChildren(...config.rules.map(renderRule));
  $('empty').hidden = config.rules.length > 0;
  if (focusKey) {
    const target = [...document.querySelectorAll('[data-key]')].find((el) => el.dataset.key === focusKey);
    if (target && !target.disabled) target.focus();
  }
  updateTestResult();
}

// ---------- test panel ----------

function updateTestResult() {
  const url = $('test-url').value.trim();
  const result = $('test-result');
  if (!url) {
    result.textContent = '';
    return;
  }
  const fullUrl = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  const { rule } = findMatchingRule(config.rules, { url: fullUrl, title: $('test-title').value });
  if (rule) {
    result.textContent = `→ Goes to “${rule.name.trim()}” (rule ${config.rules.indexOf(rule) + 1})`;
  } else {
    result.textContent = 'No rule matches — the tab is left where it is.';
  }
}

// ---------- import / export ----------

function exportRules() {
  const blob = new Blob([`${JSON.stringify(normalizeConfig(config), null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: 'auto-group-tabs-rules.json' });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function importRules(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    setStatus('backup-status', 'That file is not valid JSON.');
    return;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rules)) {
    setStatus('backup-status', 'That file does not look like an Auto Group Tabs export.');
    return;
  }
  const imported = normalizeConfig(parsed);
  if (config.rules.length > 0 && !confirm(`Replace your ${config.rules.length} current rule(s) with ${imported.rules.length} imported rule(s)?`)) {
    return;
  }
  config = imported;
  render();
  await commit();
  setStatus('backup-status', `Imported ${imported.rules.length} rule(s).`, 4000);
}

// ---------- wiring ----------

$('enabled').addEventListener('change', (event) => {
  config.enabled = event.target.checked;
  commit();
});

$('ungroup-unmatched').addEventListener('change', (event) => {
  config.ungroupUnmatched = event.target.checked;
  commit();
});

$('add-rule').addEventListener('click', () => {
  const rule = createRule();
  config.rules.push(rule);
  render(`${rule.id}:name`);
  commit();
});

$('apply-all').addEventListener('click', async () => {
  const button = $('apply-all');
  button.disabled = true;
  setStatus('apply-status', 'Grouping…');
  try {
    await saveNow();
    const response = await api.runtime.sendMessage({ type: 'applyAll' });
    if (!response?.ok) throw new Error(response?.error ?? 'No response from the extension.');
    setStatus('apply-status', response.moved === 0 ? 'All tabs were already where they belong.' : `Moved ${response.moved} tab(s).`, 5000);
  } catch (error) {
    setStatus('apply-status', `Could not group tabs: ${error?.message ?? error}`);
  } finally {
    button.disabled = false;
  }
});

$('test-url').addEventListener('input', updateTestResult);
$('test-title').addEventListener('input', updateTestResult);

$('export').addEventListener('click', exportRules);
$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  event.target.value = '';
  if (file) await importRules(file);
});

// Don't lose the last keystrokes if the page is closed within the debounce window.
const flush = () => {
  if (saveTimer !== null) saveNow();
};
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});

// Pick up changes made elsewhere (e.g. the toolbar popup) while this page is open.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEY]) return;
  const incoming = normalizeConfig(changes[STORAGE_KEY].newValue);
  if (JSON.stringify(incoming) === lastSavedJson) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  config = incoming;
  lastSavedJson = JSON.stringify(incoming);
  render();
});

config = await loadConfig(api);
lastSavedJson = JSON.stringify(config);
render();

// Pure rule model + matching logic. No browser APIs here, so it runs unchanged in
// the background script, the options page, the popup and in Node tests.

export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
export const DEFAULT_COLOR = 'blue';

export const FIELDS = ['domain', 'url', 'title'];
export const FIELD_LABELS = { domain: 'Domain', url: 'URL', title: 'Title' };

// The first operator of each field is its default.
export const OPERATORS = {
  domain: ['domain', 'equals', 'contains', 'startsWith', 'endsWith', 'regex'],
  url: ['contains', 'equals', 'startsWith', 'endsWith', 'regex'],
  title: ['contains', 'equals', 'startsWith', 'endsWith', 'regex'],
};
export const OPERATOR_LABELS = {
  domain: 'is (incl. subdomains)',
  equals: 'is exactly',
  contains: 'contains',
  startsWith: 'starts with',
  endsWith: 'ends with',
  regex: 'matches regex',
};

export const MATCH_MODES = ['any', 'all'];

const MAX_NAME_LENGTH = 100;
const MAX_VALUE_LENGTH = 2000;

function newId() {
  return globalThis.crypto.randomUUID();
}

export function createCondition(field = 'domain', value = '') {
  return { field, operator: OPERATORS[field][0], value };
}

export function createRule(overrides = {}) {
  return {
    id: newId(),
    name: '',
    color: DEFAULT_COLOR,
    enabled: true,
    matchMode: 'any',
    conditions: [createCondition()],
    ...overrides,
  };
}

function normalizeCondition(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const field = FIELDS.includes(source.field) ? source.field : 'domain';
  const operator = OPERATORS[field].includes(source.operator) ? source.operator : OPERATORS[field][0];
  const value = typeof source.value === 'string' ? source.value.slice(0, MAX_VALUE_LENGTH) : '';
  return { field, operator, value };
}

function normalizeRule(raw, usedIds) {
  const source = raw && typeof raw === 'object' ? raw : {};
  let id = typeof source.id === 'string' && source.id ? source.id : newId();
  if (usedIds.has(id)) id = newId();
  usedIds.add(id);
  return {
    id,
    name: typeof source.name === 'string' ? source.name.slice(0, MAX_NAME_LENGTH) : '',
    color: GROUP_COLORS.includes(source.color) ? source.color : DEFAULT_COLOR,
    enabled: source.enabled !== false,
    matchMode: MATCH_MODES.includes(source.matchMode) ? source.matchMode : 'any',
    conditions: Array.isArray(source.conditions) ? source.conditions.map(normalizeCondition) : [],
  };
}

/** Turns anything (missing, partial, imported, hand-edited) into a well-formed config. */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const usedIds = new Set();
  return {
    version: 1,
    enabled: source.enabled !== false,
    ungroupUnmatched: source.ungroupUnmatched === true,
    rules: Array.isArray(source.rules) ? source.rules.map((rule) => normalizeRule(rule, usedIds)) : [],
  };
}

/** Tab group titles are compared ignoring case and surrounding whitespace. */
export function sameTitle(a, b) {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

export function getHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

/**
 * Cleans up a domain typed by a user so "Amazon.com", "https://www.amazon.com/deals",
 * "*.amazon.com" and "amazon.com:443" all become a bare lowercase hostname.
 */
export function normalizeDomain(value) {
  let domain = String(value ?? '').trim().toLowerCase();
  domain = domain.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  domain = domain.split(/[/?#]/)[0];
  domain = domain.slice(domain.lastIndexOf('@') + 1);
  domain = domain.replace(/:\d*$/, '');
  domain = domain.replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.+$/, '');
  if (!domain) return '';
  try {
    // Converts internationalised names to the punycode form browsers report.
    return new URL(`http://${domain}`).hostname.replace(/\.$/, '');
  } catch {
    return '';
  }
}

const regexCache = new Map();

/** Returns a compiled case-insensitive RegExp, or null if the pattern is invalid. */
export function getRegex(pattern) {
  if (regexCache.has(pattern)) return regexCache.get(pattern);
  let regex = null;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    regex = null;
  }
  if (regexCache.size > 500) regexCache.clear();
  regexCache.set(pattern, regex);
  return regex;
}

/** A condition only takes part in matching when it has a usable value. */
export function isConditionValid(condition) {
  const value = typeof condition?.value === 'string' ? condition.value.trim() : '';
  if (!value) return false;
  if (!FIELDS.includes(condition.field) || !OPERATORS[condition.field].includes(condition.operator)) return false;
  if (condition.operator === 'regex') return getRegex(value) !== null;
  if (condition.field === 'domain' && (condition.operator === 'domain' || condition.operator === 'equals')) {
    return normalizeDomain(value) !== '';
  }
  return true;
}

export function isRuleUsable(rule) {
  return Boolean(rule?.enabled) && rule.name.trim() !== '' && rule.conditions.some(isConditionValid);
}

const stripTrailingSlash = (text) => (text.endsWith('/') ? text.slice(0, -1) : text);

/**
 * @returns true / false, or null when the answer depends on a title that is not known yet
 *          (ctx.title === null while the page is still loading).
 */
function evaluateCondition(condition, ctx) {
  const value = condition.value.trim();
  let subject;
  if (condition.field === 'title') {
    if (ctx.title === null || ctx.title === undefined) return null;
    subject = ctx.title.trim();
  } else if (condition.field === 'domain') {
    subject = ctx.hostname;
  } else {
    subject = ctx.url;
  }
  if (!subject) return false;

  if (condition.operator === 'regex') {
    const regex = getRegex(value);
    return regex ? regex.test(subject) : false;
  }

  const haystack = subject.toLowerCase();
  if (condition.field === 'domain' && (condition.operator === 'domain' || condition.operator === 'equals')) {
    const domain = normalizeDomain(value);
    if (!domain) return false;
    if (haystack === domain) return true;
    return condition.operator === 'domain' && haystack.endsWith(`.${domain}`);
  }

  const needle = value.toLowerCase();
  switch (condition.operator) {
    case 'contains':
      return haystack.includes(needle);
    case 'equals':
      return condition.field === 'url'
        ? stripTrailingSlash(haystack) === stripTrailingSlash(needle)
        : haystack === needle;
    case 'startsWith':
      return haystack.startsWith(needle);
    case 'endsWith':
      return haystack.endsWith(needle);
    default:
      return false;
  }
}

/** @returns true / false / null (undecided until the title is known). */
function evaluateRule(rule, ctx) {
  const results = rule.conditions.filter(isConditionValid).map((condition) => evaluateCondition(condition, ctx));
  if (results.length === 0) return false;
  if (rule.matchMode === 'all') {
    if (results.includes(false)) return false;
    return results.includes(null) ? null : true;
  }
  if (results.includes(true)) return true;
  return results.includes(null) ? null : false;
}

/**
 * Finds the first usable rule (in list order) matching a tab.
 *
 * @param {Array} rules
 * @param {{url: string, title: string|null}} tab  Pass title: null when it is not known yet.
 * @returns {{rule: object|null, pending: boolean}} pending is true when the outcome
 *          cannot be decided before the title is known.
 */
export function findMatchingRule(rules, tab) {
  const url = typeof tab?.url === 'string' ? tab.url : '';
  const ctx = { url, hostname: getHostname(url), title: tab?.title ?? null };
  for (const rule of rules) {
    if (!isRuleUsable(rule)) continue;
    const result = evaluateRule(rule, ctx);
    if (result === true) return { rule, pending: false };
    if (result === null) return { rule: null, pending: true };
  }
  return { rule: null, pending: false };
}

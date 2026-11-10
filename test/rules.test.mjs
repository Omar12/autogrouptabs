import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createRule,
  findMatchingRule,
  isRuleUsable,
  normalizeConfig,
  normalizeDomain,
  sameTitle,
} from '../src/lib/rules.js';

const rule = (name, conditions, extra = {}) => createRule({ name, conditions, ...extra });
const cond = (field, operator, value) => ({ field, operator, value });
const match = (rules, url, title = '') => findMatchingRule(rules, { url, title }).rule?.name ?? null;

test('domain rule matches the domain and its subdomains, case-insensitively', () => {
  const rules = [rule('Shopping', [cond('domain', 'domain', 'Amazon.com')])];
  assert.equal(match(rules, 'https://amazon.com/'), 'Shopping');
  assert.equal(match(rules, 'https://www.amazon.com/dp/B000'), 'Shopping');
  assert.equal(match(rules, 'https://smile.AMAZON.com/x?y=1'), 'Shopping');
  assert.equal(match(rules, 'https://notamazon.com/'), null);
  assert.equal(match(rules, 'https://amazon.com.evil.example/'), null);
  assert.equal(match(rules, 'https://example.com/?ref=amazon.com'), null);
});

test('domain values are cleaned up', () => {
  for (const value of ['https://www.amazon.com/deals?x=1', '*.www.amazon.com', ' WWW.Amazon.com:443 ', '.www.amazon.com.']) {
    assert.equal(normalizeDomain(value), 'www.amazon.com', value);
  }
  assert.equal(normalizeDomain('bücher.de'), 'xn--bcher-kva.de');
  assert.equal(normalizeDomain('   '), '');
  assert.equal(normalizeDomain('https://'), '');
});

test('exact domain does not include subdomains', () => {
  const rules = [rule('Exact', [cond('domain', 'equals', 'example.com')])];
  assert.equal(match(rules, 'https://example.com/a'), 'Exact');
  assert.equal(match(rules, 'https://www.example.com/a'), null);
});

test('domain contains / startsWith / endsWith / regex', () => {
  assert.equal(match([rule('G', [cond('domain', 'contains', 'google')])], 'https://mail.google.co.uk/'), 'G');
  assert.equal(match([rule('G', [cond('domain', 'startsWith', 'docs.')])], 'https://docs.python.org/'), 'G');
  assert.equal(match([rule('G', [cond('domain', 'endsWith', '.edu')])], 'https://mit.edu/'), 'G');
  assert.equal(match([rule('G', [cond('domain', 'endsWith', '.edu')])], 'https://mit.education/'), null);
  assert.equal(match([rule('G', [cond('domain', 'regex', '^(www\\.)?(ebay|etsy)\\.')])], 'https://www.etsy.com/'), 'G');
});

test('url operators', () => {
  assert.equal(match([rule('U', [cond('url', 'contains', '/Pull/')])], 'https://github.com/a/b/pull/3'), 'U');
  assert.equal(match([rule('U', [cond('url', 'startsWith', 'https://github.com/org/')])], 'https://github.com/org/x'), 'U');
  assert.equal(match([rule('U', [cond('url', 'endsWith', '.pdf')])], 'https://x.test/a.PDF'), 'U');
  assert.equal(match([rule('U', [cond('url', 'equals', 'https://x.test')])], 'https://x.test/'), 'U');
  assert.equal(match([rule('U', [cond('url', 'equals', 'https://x.test')])], 'https://x.test/a'), null);
  assert.equal(match([rule('U', [cond('url', 'regex', 'jira\\..*/browse/[A-Z]+-\\d+')])], 'https://jira.corp.test/browse/AB-12'), 'U');
});

test('title operators', () => {
  const rules = [rule('Docs', [cond('title', 'contains', 'invoice')])];
  assert.equal(match(rules, 'https://x.test/', 'March INVOICE #3'), 'Docs');
  assert.equal(match(rules, 'https://x.test/invoice', 'Receipt'), null);
  assert.equal(match([rule('T', [cond('title', 'equals', 'inbox')])], 'https://x.test/', ' Inbox '), 'T');
  assert.equal(match([rule('T', [cond('title', 'regex', '^\\(\\d+\\) ')])], 'https://x.test/', '(3) Messages'), 'T');
});

test('custom sets: any vs all', () => {
  const conditions = [cond('domain', 'domain', 'github.com'), cond('title', 'contains', 'pull request')];
  const any = [rule('Any', conditions, { matchMode: 'any' })];
  const all = [rule('All', conditions, { matchMode: 'all' })];
  assert.equal(match(any, 'https://github.com/', 'Home'), 'Any');
  assert.equal(match(any, 'https://gitlab.com/', 'A pull request'), 'Any');
  assert.equal(match(any, 'https://gitlab.com/', 'Home'), null);
  assert.equal(match(all, 'https://github.com/', 'Home'), null);
  assert.equal(match(all, 'https://github.com/', 'Pull Request #3'), 'All');
});

test('first matching rule wins; disabled, unnamed and empty rules are skipped', () => {
  const rules = [
    rule('Off', [cond('domain', 'domain', 'a.test')], { enabled: false }),
    rule('   ', [cond('domain', 'domain', 'a.test')]),
    rule('Empty', [cond('domain', 'domain', '  ')]),
    rule('NoConditions', []),
    rule('First', [cond('domain', 'domain', 'a.test')]),
    rule('Second', [cond('url', 'contains', 'a.test')]),
  ];
  assert.equal(match(rules, 'https://a.test/'), 'First');
  assert.equal(isRuleUsable(rules[2]), false);
});

test('blank and invalid-regex conditions never match and never break "all" rules', () => {
  assert.equal(match([rule('R', [cond('url', 'contains', '')])], 'https://a.test/'), null);
  assert.equal(match([rule('R', [cond('url', 'regex', '([')])], 'https://a.test/(['), null);
  const all = [rule('R', [cond('domain', 'domain', 'a.test'), cond('title', 'contains', ' ')], { matchMode: 'all' })];
  assert.equal(match(all, 'https://a.test/', 'x'), 'R');
});

test('unknown title makes title-dependent outcomes pending, but only when it matters', () => {
  const titleRule = rule('T', [cond('title', 'contains', 'x')]);
  const domainRule = rule('D', [cond('domain', 'domain', 'a.test')]);
  const find = (rules, url) => findMatchingRule(rules, { url, title: null });

  assert.deepEqual(find([domainRule, titleRule], 'https://a.test/'), { rule: domainRule, pending: false });
  assert.deepEqual(find([titleRule, domainRule], 'https://a.test/'), { rule: null, pending: true });

  const anyRule = rule('Any', [cond('title', 'contains', 'x'), cond('domain', 'domain', 'a.test')]);
  assert.equal(find([anyRule], 'https://a.test/').rule, anyRule);
  assert.equal(find([anyRule], 'https://b.test/').pending, true);

  const allRule = rule('All', [cond('title', 'contains', 'x'), cond('domain', 'domain', 'a.test')], { matchMode: 'all' });
  assert.deepEqual(find([allRule], 'https://b.test/'), { rule: null, pending: false });
  assert.equal(find([allRule], 'https://a.test/').pending, true);
});

test('non-web and malformed URLs are handled', () => {
  const rules = [rule('D', [cond('domain', 'domain', 'a.test')]), rule('Ext', [cond('url', 'startsWith', 'chrome://extensions')])];
  assert.equal(match(rules, 'about:blank'), null);
  assert.equal(match(rules, ''), null);
  assert.equal(match(rules, 'not a url'), null);
  assert.equal(match(rules, 'chrome://extensions/'), 'Ext');
  assert.deepEqual(findMatchingRule(rules, undefined), { rule: null, pending: false });
});

test('normalizeConfig repairs bad input', () => {
  assert.deepEqual(normalizeConfig(undefined), { version: 1, enabled: true, ungroupUnmatched: false, rules: [] });
  assert.deepEqual(normalizeConfig('junk').rules, []);
  const config = normalizeConfig({
    enabled: false,
    ungroupUnmatched: 'yes',
    rules: [
      null,
      { id: 'a', name: 5, color: 'teal', matchMode: 'none', conditions: 'x' },
      { id: 'a', name: 'Dup', color: 'red', enabled: false, matchMode: 'all', conditions: [{ field: 'title', operator: 'domain', value: 7 }, { field: 'bogus' }] },
    ],
  });
  assert.equal(config.enabled, false);
  assert.equal(config.ungroupUnmatched, false);
  assert.equal(config.rules.length, 3);
  assert.equal(new Set(config.rules.map((r) => r.id)).size, 3);
  assert.deepEqual({ ...config.rules[1], id: 0 }, { id: 0, name: '', color: 'blue', enabled: true, matchMode: 'any', conditions: [] });
  assert.deepEqual(config.rules[2].conditions, [
    { field: 'title', operator: 'contains', value: '' },
    { field: 'domain', operator: 'domain', value: '' },
  ]);
  assert.deepEqual(normalizeConfig(config), config);
});

test('sameTitle ignores case and surrounding whitespace', () => {
  assert.equal(sameTitle(' Shopping ', 'shopping'), true);
  assert.equal(sameTitle('Shopping', 'Shop'), false);
  assert.equal(sameTitle(undefined, ''), true);
});

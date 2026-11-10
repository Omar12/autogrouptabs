# Auto Group Tabs

A Chrome and Firefox extension that automatically puts tabs into named tab groups, based on rules you define.

Example: any tab on `amazon.com` goes into the tab group **Shopping**. If a Shopping group already exists in that window the tab joins it; if not, the group is created.

## Rules

Each rule has a tab group name, a colour, and one or more conditions. A rule matches when **any** or **all** of its conditions match (your choice), so a rule can be a single domain or a custom set of matches.

| Match on | Ways to match |
| --- | --- |
| Domain | is (incl. subdomains), is exactly, contains, starts with, ends with, regex |
| URL | contains, is exactly, starts with, ends with, regex |
| Title | contains, is exactly, starts with, ends with, regex |

- Matching ignores upper/lower case. `Amazon.com`, `https://www.amazon.com/deals` and `*.amazon.com` are all accepted as domain values.
- Rules are checked top to bottom and the first match wins. Reorder them with the arrows.
- Group names are compared ignoring case, and groups are per window.
- A tab is only moved when its matching rule changes, so a tab you drag out of a group stays out until it navigates somewhere that matches a different rule. **Group open tabs now** re-applies every rule on demand.
- Tabs that match no rule are left alone. Optionally, tabs the extension grouped can be removed from their group when they stop matching.
- Pinned tabs are never grouped.
- Title conditions are evaluated once the page has finished loading.

The toolbar popup can pause grouping, add the current site to a group in one step, and group all open tabs. Rules are stored locally in the browser and can be exported/imported as JSON from the options page.

## Install from source

Requires Node.js 18+ (no dependencies to install).

```sh
npm run build
```

This produces `dist/chrome` and `dist/firefox`.

- **Chrome / Edge / Brave** (Chrome 102+): open `chrome://extensions`, enable *Developer mode*, click *Load unpacked* and choose `dist/chrome`.
- **Firefox** (139+, the first version with the tab groups API): open `about:debugging#/runtime/this-firefox`, click *Load Temporary Add-on…* and choose `dist/firefox/manifest.json`.

To package for the stores, zip the *contents* of each folder, e.g. `cd dist/firefox && zip -r ../autogrouptabs-firefox.zip .`

## Development

```
src/background.js      event wiring (service worker in Chrome, event page in Firefox)
src/lib/rules.js       rule model and matching (pure, no browser APIs)
src/lib/grouper.js     decides where a tab belongs and moves it
src/options/           rule editor
src/popup/             toolbar popup
manifests/             shared manifest + per-browser differences
```

```sh
npm test            # unit tests (Node's built-in test runner)
npm run test:e2e    # loads dist/chrome in real Chromium; needs Playwright + Chromium
```

Permissions used: `tabs` (read tab URLs and titles), `tabGroups` (create and name groups), `storage` (save your rules). The extension makes no network requests.

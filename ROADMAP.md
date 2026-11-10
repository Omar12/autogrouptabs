# Roadmap

Future features to explore. Nothing here is committed or scheduled; items are listed in priority order.

## 1. AI-assisted grouping with your own API key

Let the user supply their own AI provider API key and have the extension suggest or create tab groups from what a page is actually about, not only its domain, URL or title.

**Goals**

- Bring your own key: the user enters an API key for a provider of their choice. The extension ships with no key and no backend of its own.
- Group by page content: classify a tab using the text of the page, so pages that rules cannot describe (an article, a product page on an unknown shop, a research paper) still land in a sensible group.
- Create new groups: the AI can propose a group that does not exist yet, as well as assign tabs to existing ones.
- Never read sensitive pages: pages likely to contain personal information must be excluded from content reading, so their content is never sent to an AI provider.

**Open questions to explore**

- How to recognise sensitive pages. Candidates: a built-in and user-editable blocklist (banking, health, email, government, password managers), skipping pages with password or payment fields, skipping private/incognito windows, and an allowlist-only mode where the AI reads only sites the user has approved.
- How much content to send: full text, a truncated excerpt, or only metadata such as headings and the meta description.
- Whether the AI acts automatically or only suggests groups for the user to confirm.
- How AI grouping interacts with rules. Likely: user rules always win, and the AI only handles tabs no rule matched.
- Which providers to support, and whether to support local models so nothing leaves the machine.
- Where the key is stored (local only, never synced) and how to make clear to the user what is sent and to whom.
- Cost and rate control: caching decisions per URL, and limits on requests per minute.
- Permissions: reading page content needs host permissions the extension does not request today. These should be optional and requested only when the feature is turned on.

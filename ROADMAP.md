# Roadmap

This roadmap is intentionally conservative. The project should stay easy to deploy, easy to understand, and Cloudflare-native.

## Current Foundation

- Cloudflare Workers Static Assets + Worker API.
- D1 for structured configuration.
- Worker Secrets for admin and download tokens.
- Cloudflare Deploy Button for quick installs.
- Agent / CLI installer for seeded sources and collections.
- Local release gates instead of GitHub CI/CD.

## Near-Term Priorities

- Improve deployment troubleshooting and diagnostics.
- Add focused tests around Worker API behavior and output targets.
- Tighten docs for common Mihomo, sing-box, URI, and JSON workflows.
- Improve import/export safety and validation messages.
- Add screenshots or short GIFs after the UI stabilizes.

## Later, If Needed

- More built-in routing templates when there is clear demand.
- More filter presets when they map cleanly to the existing filter DSL.
- More deployment examples for custom domains and split download domains.
- English translations for deployment-critical docs.

## Not Planned by Default

- R2, KV, Durable Objects, Queues, Cron, or extra Cloudflare products.
- File hosting.
- Gist, GitLab, or third-party sync providers.
- Sharing platform.
- Archive/history system.
- Script runtime or script marketplace.
- Log panel.
- Full upstream Sub-Store API compatibility.

These may be reconsidered only if the product boundary changes explicitly.

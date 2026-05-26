# Memory — House MD

## Hive Owner
- [Populated during setup]

## Agents Built
- [Updated as agents are created]

## Infrastructure
- [Updated as configuration decisions are made]

## Future Direction (logged 2026-05-06)
- Owner is building toward "skill shops" + "custom built bundled skill agents" — a marketplace model where curated skill packs ship as add-ons, and pre-bundled agents ship with skills baked in.
- Templates + skills delivery in v1.5.0+ must be designed extensibly so this can layer on without retrofit. Don't hard-code "skills come from framework only" — make the source pluggable so future skill packs can come from other registries.

## v1.5.0 Decisions (locked 2026-05-06)
- **Scope pivot:** Framework/state separation DROPPED. Owner not in favor of structurally changing the Hive layout. `~/neato-hive/` stays as today.
- Real goal: move end users off GitHub for installs/updates → website-tarball distribution + local web dashboard served by the Hive itself.
- Distribution: tarball from website, not git pull. End users never touch GitHub. Public website is install/changelog only — invisible to users after install (except as background version source for `hive update`).
- `hive update` fetches from website's `/api/current`, verifies SHA-256, overlay-applies via REPLACE_LIST/PRESERVE_LIST. Per-Hive state (agents/, data/, config/*.local.yaml, .env) never touched.
- Local dashboard: new `hive-dashboard` PM2 process, Express server on `0.0.0.0:7777`, serves SPA + API at same origin. Tailscale-routable so owner reaches it from any tailnet device. Token auth via `~/.config/neato-hive/dashboard-token`.
- Dashboard pages: Overview, Agent Detail, Doctor, Updates (with SSE+polling fallback for self-update tear-down), Backups, Tasks.
- GUI installer: osascript on Mac, zenity/whiptail on Ubuntu. Fresh-install only — ongoing ops happen in browser dashboard.
- Linux support: Ubuntu 22.04 LTS only for v1.5.x.
- Multi-hive on one machine: dropped. Owner uses Proxmox for multiple hives.
- Password protection: dropped (defer to v1.6.x if needed).
- Domain: Vercel default for now, custom later.
- New-agent GUI wizard: dropped. House MD's Discord interview stays the path.
- Backups: standardized at `~/.neato-hive/backups/<timestamp>/` before any destructive op.
- Owner's personal backup of agent files lives on Desktop, hands-off.

## v1.5.0 WBS Status (logged 2026-05-06)
- Glados decomposed into 30 PRs + 2 owner ceremonies across 10 phases (A–J). Project file: `agents/glados/projects/v1.5.0-website-installer-dashboard.md`.
- 12 architectural questions resolved. SSE state-file architecture (Q1) confirmed. node_modules ABI: drop pre-built, run `pnpm install --frozen-lockfile` post-extract (Q2 option b).
- Phase A.0 = owner ceremony: create `Daniel-Neato/neato-hive-site` repo + Vercel project + confirm tailnet name. Surfaced to owner 2026-05-06.
- Sequencing: v1.4.9 must merge first → A.0 ceremony → A.1 dispatches.
- v1.4.10 (original website plan) absorbed into v1.5.0 phases A/B/F.

## Coding Backend Policy (locked 2026-05-06)
- **All coding-task dispatches use `--kind codex` strictly.** No `--kind claude` until owner says otherwise.
- Reason: conserve Anthropic usage window. Bob hit limits earlier today.
- Propagated to glados (task t-moul3bj20003) and atlas (task t-moul3hhs0004).
- Bob's current 4fqk task already on codex — no change.
- Each agent should bake this into their operating loop so it doesn't drift between sessions.

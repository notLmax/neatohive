# Neato Hive

Your personal AI agent runtime. Runs on your Mac, talks to you in Discord, does work for you.

A "Hive" is a collection of AI agents you build to handle your work — research, coding, data, scheduling, whatever you need. Each agent lives in its own Discord channel. You chat with them like you'd chat with a coworker.

You start with one agent — **House MD** — who builds all your future agents for you. Tell House what you need, he interviews you, he builds the agent, it shows up in your Discord.

---

## What you'll have when this is done

- A Discord server where each channel is a different AI agent
- **House MD** — your first agent, who builds, configures, and maintains every other agent in your hive
- **Coding Agent Template** — ready-to-customize coding agent: specs projects, runs Codex / Claude Code CLI, reviews and deploys
- **Generalist Template** — stripped-down base for research, writing, operations, etc.
- Everything running on your Mac, auto-starting when you log in
- ~5–10 minutes of setup per new agent after the first one (House handles most of it)

---

## Before you start — prerequisites

### You must have these installed

The wizard will not install these. Do this first.

| Requirement | How to get it | Verify |
|---|---|---|
| macOS or Linux machine you leave on 24/7 | — | — |
| Node.js 18+ (22 LTS recommended) | [nodejs.org](https://nodejs.org) | `node -v` |
| Homebrew (macOS only) | [brew.sh](https://brew.sh) | `brew -v` |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code` | `claude --version` |
| Git | Usually preinstalled on macOS | `git --version` |

> **Why "24/7"?** Your agents run as background processes on this machine. If the machine is off, the agents are offline and can't respond in Discord. Most people use their work laptop or a dedicated Mac mini.

### You must have these accounts ready

- **Claude Max subscription** (5x or 20x) — Pro, Free, and Team Standard will not work for 24/7 agent usage. You'll authenticate during setup with `claude setup-token`.
- **Discord account + your own Discord server** (or admin rights on one). Each agent is a bot + a channel.
- **Discord Developer Portal access** — [discord.com/developers/applications](https://discord.com/developers/applications). You'll create one bot per agent.
- **GitHub account** — you need repo access to `anthonyconnelly/neato-hive`. Ask AC to add you.
- **Your Discord User ID** — enable Developer Mode in Discord (Settings → Advanced → Developer Mode), then right-click your name and "Copy User ID". The wizard asks for this.

### Optional (the wizard will prompt you)

- **1Password account + service account token** — only if you want agents to share credentials (API keys, service account JSON files).
- **Google Cloud project** — only if you want agents that read/write Google Workspace (Drive, Sheets, Gmail, Calendar) or run BigQuery.
- **GitHub Personal Access Token** — for the `gh` CLI, if agents need to work with GitHub.

---

## Install

```bash
git clone https://github.com/anthonyconnelly/neato-hive.git
cd neato-hive
./setup.sh
```

The wizard takes about 10 minutes. Plan for an hour — most of the time is Discord bot creation (one bot per agent).

At any point:
- **Ctrl-C** to pause. Your progress is saved.
- `./setup.sh --resume` to continue from where you paused.
- `./setup.sh --fresh` to start over (asks for confirmation).

**On Parsec into a Mac?** Parsec remaps Ctrl-C to Cmd-C on the host. To exit the wizard: open a new terminal tab (⌘T) and run `pkill -f setup.sh`.

### What the wizard does, step by step

1. **Node.js** — checks you have it
2. **Tools** — installs PM2, gh, jq, tmux, ffmpeg, pandoc, sqlite3, op, gws, bq, and a few others via Homebrew
3. **Claude Code CLI** — checks you have it
4. **Claude auth** — verifies you ran `claude setup-token` with a Max account
5. **Codex CLI (optional)** — installs OpenAI's coding CLI if you have an OpenAI Pro subscription; skip otherwise
6. **Discord** — walks you through creating your first bot (House MD) in the Discord Developer Portal, pasting the token
7. **Google Workspace (optional)** — one-click OAuth for Drive, Sheets, Gmail, Calendar, Docs access
8. **1Password (optional)** — sets up the `op` CLI with your service account token
9. **Directories** — creates your working directory
10. **Install & build** — installs Node dependencies, compiles the runtime
11. **Boot persistence** — tells your Mac to launch all your agents when you log in

When setup finishes: House MD starts running. Open Discord, find the `#house-md` channel, and say hi.

---

## After setup

Talk to House MD in Discord. He'll walk you through building your next agent.

### The `hive` CLI

The `hive` command is installed globally. Run it from any directory.

#### Agent management
```bash
hive status                       # PM2 status for all agents
hive list                         # List all configured agents
hive info <agent>                 # Detailed info: files, memory, session, PM2
hive start <agent|all>            # Start an agent or all agents
hive stop <agent|all>             # Stop an agent or all agents
hive restart <agent|all>          # Restart an agent or all agents
hive logs <agent> [lines]         # View agent logs (default: 30 lines)
```

#### Sessions
```bash
hive newsession <agent>           # Clear session — next message starts fresh
hive session <agent>              # Show current session info
```

#### Build & update
```bash
hive build                        # Compile TypeScript
hive update                       # Pull latest code, rebuild, restart
hive version                      # Show version info
```

#### Diagnostics
```bash
hive doctor                       # Full health check
hive env                          # Show .env status (masked values)
hive config                       # Show parsed config summary
```

Agent names auto-normalize — `hive logs son of anton` works the same as `hive logs son-of-anton`.

### Updating

```bash
hive update
```

Pulls the latest framework code (source, templates, CLI, shared files, skills), rebuilds, and restarts all agents. Your agents, config, memory, and `.env` are never touched.

---

## Architecture

```
hive/
├── bin/
│   └── hive              # CLI script (global via npm link)
├── agents/               # Each agent's behavior files + memory
│   ├── house-md/         # Ships with Hive
│   └── <your-agents>/    # Built by House MD
├── templates/
│   ├── coding-agent/     # Full coding agent template
│   └── generalist/       # Base template for any role
├── config/
│   └── config.yaml       # Agent definitions, model, safety rules
├── src/
│   ├── core/             # Agent SDK wrapper, prompt builder, sessions
│   ├── discord/          # Discord bot, message routing
│   ├── safety/           # Command filter, injection guard, hooks
│   └── tools/            # Custom tools (cron, memory, messaging, etc.)
├── shared/               # Files auto-injected into all agents
│   ├── CRITICAL-RULES.md # Universal rules for all agents
│   ├── GLOBAL-TOOLS.md   # Available tools and CLIs
│   └── NEATO-NARRATIVE.md# Brand positioning reference
├── skills/               # On-demand reference docs (loaded when needed)
├── .env                  # Bot tokens, owner ID (never committed)
└── .env.example          # Template for .env
```

### How it works

1. Each agent runs as its own PM2 process (`dist/index.js --agent <name>`)
2. Each agent has its own Discord bot token and listens on its own channel(s)
3. The system prompt is assembled from behavior files in `agents/<name>/`, plus `shared/` files injected into every agent
4. Skills provide on-demand reference docs — listed in the prompt catalog, loaded only when needed
5. Sessions persist across restarts via `agents/<name>/session.json`
6. Daily memory files are written to `agents/<name>/memory/YYYY-MM-DD.md`
7. Only the Discord server owner can talk to agents (enforced by `DISCORD_OWNER_ID`)

## Behavior Files

Every agent is defined by markdown files that control its identity, rules, personality, and memory:

| File | Purpose | Who Writes It |
|------|---------|---------------|
| IDENTITY.md | Name, role, one-line description | House MD |
| AGENTS.md | Workflows, procedures, permissions | House MD |
| SOUL.md | Personality, communication style | House MD |
| USER.md | Who the owner is, interaction style | House MD |
| MEMORY.md | Persistent facts across sessions | The agent itself |
| LESSONS.md | Corrections (append-only) | The agent itself |
| TASKS.md | Active and completed tasks | The agent itself |

---

## Getting help

- Something broke? Talk to House MD. Diagnosing agents is his job.
- Something broke in the wizard itself, before House exists? Ping AC.
- Want to learn the system? Read `docs/` and `shared/`.

## Recovery

If `hive update` fails partway through (overlay revert, PRESERVE_LIST drift detected, finalize failed), the cause is almost always a bug in your currently installed `bin/hive` — and the fix lives in a newer release you can't install because the broken `bin/hive` is what runs `hive update`.

To break the loop, refresh just `bin/hive` from the latest release without touching the rest of your install:

```bash
curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash -s -- --repair
hive update
```

The `--repair` flag downloads the latest release tarball, verifies its checksum, extracts only `bin/hive`, and swaps it in. Your existing `bin/` directory is preserved as a sibling backup directory named `bin.repair-backup-<UTC-timestamp>/`, and older repair backups are auto-pruned so only the 5 most recent remain. After repair, `hive update` runs with the new logic and the rest of the overlay applies normally.

What's preserved:
- All agent state (`agents/<name>/*` — memory, sessions, delegation registries)
- All workspace files (`.env`, `dashboard/data`, `config/users.local.yaml`)
- Daemons stay running (repair doesn't restart PM2 processes)

What's swapped:
- Only `bin/hive` (the framework's update tooling)

## License

Proprietary — Neato Trading LLC. Internal use only.

---

## Version History

### v1.1.12 — 2026-04-23

**Onboarding UX: README, pre-flight check, in-wizard escape hatches**

Three dogfood-driven fixes to reduce new-hire onboarding friction.

- **README rewritten** — onboarding-first structure: what Hive is, what you'll have at the end, hard prereqs with verify commands, account prereqs, install, wizard step preview, hive CLI reference, architecture.
- **Step 0: Pre-flight Check** — auto-verifies OS, Node 18+ (recommends 22 LTS), Homebrew, Claude Code CLI, Git, GitHub repo access. Confirms Max subscription / Discord server / User ID. Fails early with the exact install command so users never have to go searching mid-wizard.
- **Opening screen** — fresh-run only, shows what's about to happen, time estimate, and every way to exit cleanly (Ctrl-C, `--resume`, `--fresh`, Parsec `pkill` workaround).
- **Escape-hatch footers** on 5 blocking prompts (Claude auth, Discord token, Discord user ID, gws auth, 1Password). Dim one-liner pointing to Ctrl-C + `--resume` + Parsec workaround.
- **Stale-info fixes** — Claude CLI install (`curl | bash` → `npm install -g @anthropic-ai/claude-code`), subscription guidance (MAX/Pro → Max 5x/20x only).
- `package.json`, `setup.sh` WIZARD_VERSION: 1.1.11 → 1.1.12.

### v1.1.11 — 2026-04-23

**Setup wizard: clearer `--fresh`, resume, and interrupt wording**

Three targeted wording fixes to the recovery UX.

- `--fresh` now confirms before nuking state (prompts `Delete state and restart from Step 1? (y/N)` with step count). `--yes` / `-y` flag added for scripting.
- Resume menu: `[S] Start over (delete progress)` → `[S] Delete state and restart from Step 1`.
- Interrupt handler uses `--resume` explicitly and color-highlights commands in CYAN.
- `--help` updated to list `--yes` and mention `--fresh` confirmation.

### v1.1.10 — 2026-04-23

**Setup wizard: Step 11 — PM2 boot persistence**

Final wizard step. Installs the launchd agent so all your agents auto-start when you log in.

- New Step 11 "Boot Persistence" — runs `pm2 save`, detects/verifies `~/Library/LaunchAgents/pm2.$USER.plist` content (not `launchctl list`, which fails across sudo/user session boundary), prompts user to paste the elevated `pm2 startup` command when needed, uses `plutil -extract` to validate UserName + PM2_HOME fields.
- User pastes the sudo command manually (no wizard-held passwords).
- Exits gracefully with `./setup.sh --resume` hint if first install needed.

### v1.1.9 — 2026-04-23

**Setup wizard: Google Workspace auth via shared OAuth client**

v1.1.7 shipped the gws auth step, but `gws auth setup` requires each user to provision their own GCP project (via `gcloud`), which breaks for any Neato employee who isn't a project owner. This rewrites Step 7 to use a single shared OAuth Desktop Client baked into the wizard — zero per-user project setup.

- `setup.sh` Step 7: drops the `gws auth setup` + `gcloud` dependency entirely. Writes the shared Neato OAuth client (`neato-gws-cli` project, Workspace APIs already enabled) to `~/.config/gws/client_secret.json` via heredoc, then runs `gws auth login -s drive,sheets,gmail,calendar,docs` so the consent screen only shows what Neato agents actually use
- Per Google's OAuth 2.0 spec for installed apps, desktop client secrets are not confidential — security comes from the redirect URI + user consent (every GCP SDK ships with an embedded one). This lets every Neato employee run the wizard without provisioning their own GCP project
- `client_secret.json` written with `chmod 600`
- Idempotent — if `gws auth status` already reports `oauth2` authed, Step 7 skips
- `package.json`: 1.1.8 → 1.1.9

### v1.1.8 — 2026-04-23

**Hotfix: setup.sh Step 9 crash on macOS (BSD sed)**

Every fresh install was failing at Step 9 with `sed: RE error: parentheses not balanced`, leaving users stuck and needing `hive doctor --fix-setup`.

- `setup.sh` line 876: the `sed` call that patches `config/config.yaml` allowed_paths used `|` as both the substitution delimiter AND as regex alternation inside `(~/neato-hive|~/hive)`. BSD sed on macOS parsed the first `|` in the pattern as end-of-search, producing a malformed expression with an unclosed `(`. Fixed by switching the delimiter to `#` so `|` is only interpreted as alternation.
- `bin/hive`: VERSION bumped 1.1.6 → 1.1.8 (prior release missed this bump)
- `package.json`: 1.1.7 → 1.1.8

Existing installs that hit the crash: `hive update` to pull the fix, then `./setup.sh --resume` (or `hive doctor --fix-setup`).

### v1.1.7 — 2026-04-22

**Setup wizard: Google Workspace auth + 1Password, Linux `gws` install fix**

Builds on v1.1.6's resumable wizard by adding two optional steps (gws auth, 1P setup), both checkpointed so they resume cleanly.

- `setup.sh`: renumbered steps from 8 → 10 to accommodate two new optional stages (each wrapped in `step_done` so resume works)
- New Step 7/10 **Google Workspace Auth** (optional): runs `gcloud auth login` (if no human account authed), then hands off to `gws auth setup` — its interactive wizard picks a GCP project, enables the Workspace APIs, creates the OAuth Desktop Client, and grants scopes
- New Step 8/10 **1Password Setup** (optional): walks the user through creating a vault + service account in the 1P web UI, captures `OP_SERVICE_ACCOUNT_TOKEN` and `OP_VAULT_NAME`, validates the token, writes both to `.env` progressively
- `.env.example`: added `OP_SERVICE_ACCOUNT_TOKEN` and `OP_VAULT_NAME`
- `shared/CREDENTIALS.md` (new): generic 1P reference — one vault per Hive installation, shared across that employee's agents; `op read "op://$OP_VAULT_NAME/..."` patterns; troubleshooting
- `shared/GLOBAL-TOOLS.md`: `op` row now references `$OP_VAULT_NAME` and links to `CREDENTIALS.md`
- OP token input uses `read -s -p` so the token doesn't leak to terminal or shell history; vault validation parses `op vault list` JSON via python instead of grep
- `package.json`: version bumped to 1.1.7

### v1.1.6 — 2026-04-22

**Setup wizard recovery: resume, diagnose, fix**

When the wizard fails or a user walks away mid-setup, they can now resume or diagnose without starting over.

- **Resumable `setup.sh`** — each completed step is checkpointed in `./.setup-state`. Re-running the wizard prompts: `[R]esume / [S]tart over / [Q]uit`. New flags: `--fresh` (force restart) and `--resume` (auto-resume).
- **Progressive `.env` writes** — Discord credentials persist at the end of Step 6, `WORKING_DIR` at end of Step 7. Step 8 no longer holds user input in memory, so resume-into-install-and-build just works.
- **Trap handler** — Ctrl-C, error, or unexpected exit prints resume instructions instead of leaving the user guessing.
- **New: `hive doctor --fix-setup`** — diagnoses setup artifacts (.env credentials, Claude auth, gcloud virtualenv bootstrap, 1P vault access, config.yaml allowed_paths, PM2 house-md process) and offers per-check interactive fixes (`[y/N]`).
- **Catches the gcloud virtualenv bug** — Homebrew's Python 3.13 doesn't ship `virtualenv` by default, which breaks gcloud Cask post-install. Doctor flags it and offers the one-line fix.
- **New skill: `wizard-troubleshoot`** — House MD loads this when owner/coworker reports wizard failures. Playbook of known issues, diagnostic protocol, guidance on first-principles debugging.
- `package.json` + `bin/hive`: bumped to 1.1.6
- `.gitignore`: ignore `.setup-state`

**Known limitation:** if you update Hive (git pull / `hive update`) between setup attempts, the wizard version embedded in `.setup-state` won't match; wizard force-restarts to prevent running new step logic against stale checkpoint data. Completed steps are idempotent and will no-op quickly on second pass.

### v1.1.4 — 2026-04-22

**Real fix: safety hooks now expand `~` in allowed_paths / protected_paths**

Root cause of the fresh-install write-block issue was deeper than v1.1.2/1.1.3 assumed. The safety hook did a literal `filepath.startsWith("~/neato-hive")` against absolute paths like `/Users/name/neato-hive/...` — which can never match. The hook never expanded `~`, so the allowlist was effectively dead for every entry using home-relative paths.

- `src/safety/safety-hooks.ts`: added `expandPath()`, applied to `allowed_paths` and `protected_paths` once at hook construction
- This also fixes the parallel bug where `~/.ssh` in `protected_paths` was silently non-protective
- Verified with 6/6 test cases covering allowed, protected, and unrelated paths

v1.1.2's config default change and v1.1.3's `hive update` auto-repair remain in place as belt-and-suspenders for non-standard install locations. But the actual bug was in the hook code.

Existing installs: `hive update` will pull the fixed hook code and rebuild. No manual config edit required anymore.

### v1.1.3 — 2026-04-22

**`hive update` now auto-repairs the v1.1.1 path bug**

- `hive update`: detects if the install directory is missing from `config/config.yaml` allowed_paths and patches it automatically (only touches legacy default entries, never user-added paths)
- Existing broken installs can now fix themselves by running `hive update` — no manual edit needed

### v1.1.2 — 2026-04-22

**Fix: safety hooks blocked writes on fresh installs**

- `config/config.yaml`: `allowed_paths` default changed from `~/hive` to `~/neato-hive` to match the README clone convention
- `setup.sh`: now detects the actual install directory at setup time and patches `allowed_paths` to match, so Hive works regardless of where you clone it
- `bin/hive doctor`: new check that detects install-path / allowed_paths mismatch and prints a one-line fix command
- Existing installs that hit the issue: run `hive doctor` or manually edit `config/config.yaml` and change `- ~/hive` to `- ~/neato-hive` (or wherever you cloned), then `hive restart`

### v1.1.1 — 2026-04-17

**Default model: Claude Opus 4.7**

- Updated `config/config.yaml` default from `claude-opus-4-6` to `claude-opus-4-7`
- Updated fallback in `src/discord/bot.ts` to match
- Verified compatibility with Claude MAX/Pro setup-token auth (SDK + CLI both pass)
- Existing installs: run `hive update` then edit `config/config.yaml` to set `model: claude-opus-4-7`, then restart agents

### v1.1.0 — 2026-04-11

**Production Cleanup & Skills System**
- Skills system: progressive disclosure — catalog in prompt, full docs loaded on demand
- 6 skills: hive-architecture, codex-protocol, gws-reference, bigquery-reference, hivemind, workflow-protocol
- Shared rules: `shared/CRITICAL-RULES.md` auto-injected into all agents (replaces per-agent copies)
- Removed per-agent CRITICAL-RULES.md and TOOLS.md files (content consolidated into shared/ and AGENTS.md)
- Prompt optimization: trimmed NEATO-NARRATIVE, GLOBAL-TOOLS, all AGENTS.md files
- Templates cleaned: generic names, updated file references, removed stale files
- Scrubbed all personal references from distributable
- Crash loop protection: auto-clear session after 3+ restarts in 60s
- `/status` slash command: tokens, cache %, context fill, compactions, cost, session info
- Token usage logging to `data/usage.jsonl`
- Hivemind: agent-to-agent messaging via #hivemind channel with loop prevention
- Cron agent execution: scheduled tasks can trigger AI agent work
- Setup wizard: full toolchain install (gh, op, gws, bq, vercel, jq, tmux, ffmpeg, pandoc, sqlite3)
- `hive update` now pulls shared/ and skills/ alongside source and templates

### v1.0.4 — 2026-04-10

**Safety Hooks & Image Support**
- Safety layer wired into agent runtime via SDK `PreToolUse`/`PostToolUse` hooks
- Bash hook: blocklist matching, destructive pattern detection, protected path enforcement, sudo blocking
- Write/Edit hook: protected path and allowed directory enforcement
- WebFetch/WebSearch hook: prompt injection pattern scanning on fetched content
- Smart boundary detection — `rm -rf /` blocked, `rm -rf /Users/.../temp` allowed
- Image/screenshot support: Discord attachments passed as URLs directly to Anthropic API
- Zero-latency image analysis — no base64 download, API fetches from Discord CDN

### v1.0.3 — 2026-04-10

**Custom Tools**
- Wired 13 custom tools into agent runtime via in-process MCP server (`createSdkMcpServer`)
- Cron: `CronCreate`, `CronList`, `CronDelete` — scheduled jobs with persistence
- Memory: `MemorySearch`, `MemoryGet`, `MemoryAppend` — keyword search and write to MEMORY.md
- Patch: `FilePatch` — atomic multi-hunk file editing
- Process: `ProcessStart`, `ProcessList`, `ProcessLogs`, `ProcessKill`, `ProcessSendKeys` — background process management
- Messaging: `SendMessage` — cross-channel Discord messaging between agents
- Fixed `memory.ts` ESM import bug and `process.ts` Node 24 deprecation warning

### v1.0.2 — 2026-04-10

**Setup Hardening**
- `setup.sh`: ANTHROPIC_API_KEY conflict detection and safe removal (scans env + 4 shell profiles, creates .bak backups)
- `setup.sh`: Claude auth type verification (rejects API key auth, requires subscription)
- `setup.sh`: Bot token format validation (regex check with retry prompt)
- `setup.sh`: Discord owner ID format validation (17-20 digit number check)
- `setup.sh`: PM2 PATH auto-fix (`ensure_npm_global_path` detects and persists npm global bin)
- `setup.sh`: Post-start health check (3s wait, PM2 status check, common error suggestions)
- `setup.sh`: Idempotent re-runs (deletes existing PM2 process before starting)
- `hive doctor`: ANTHROPIC_API_KEY conflict detection (checks env + shell profiles)
- `hive doctor`: Claude auth type check (flags API key usage vs subscription)

### v1.0.1 — 2026-04-09

**Hive CLI**
- Added `bin/hive` — 15 commands for managing agents, sessions, builds, and diagnostics from the terminal
- Global install via `npm link` (works from any directory)
- Agent name auto-normalization (`"son of anton"` -> `"son-of-anton"`)
- `hive update` pulls only framework files — never touches user workspace
- `hive doctor` runs full health check: prerequisites, build freshness, per-agent file/token/PM2 verification
- The dashboard now binds `127.0.0.1:7777` by default; remote Tailscale Serve exposure is opt-in during install or later via `hive doctor --fix-tailscale`
- Dashboard auth is opt-in via `DASHBOARD_REQUIRE_AUTH=true`; the default path is no login on localhost or your tailnet URL
- Setup wizard now includes `npm link` step and references `hive` commands

### v1.0.0 — 2026-04-09

**Initial Release**
- Claude Agent SDK runtime with Discord interface
- Per-agent PM2 processes with independent bot tokens
- Behavior file system: deterministic prompt assembly from markdown files
- Session persistence across restarts
- Daily memory system (last 2 days auto-injected into context)
- Safety layer: command blocklist, path restrictions, prompt injection detection
- Setup wizard (`setup.sh`) — 8-step guided installation
- House MD agent — builds and maintains all other agents
- Coding agent template — Codex/Claude Code CLI workflow
- Generalist agent template
- Codex MCP integration for coding agents
#   n e a t o h i v e  
 
# Global Tools — Available to All Agents

---

## SDK Built-in Tools

| Tool | Purpose |
|------|---------|
| Bash | Shell commands, system CLIs, scripts |
| Read | Read files (supports offset/limit for targeted reads) |
| Write | Create or overwrite files |
| Edit | String replacement edits on existing files |
| Glob | Fast file pattern matching |
| Grep | Regex text search across files |
| WebSearch | Search the web |
| WebFetch | Fetch content from URLs |

---

## System CLIs (via Bash)

| CLI | Purpose |
|-----|---------|
| `op` | 1Password — `op read "op://$OP_VAULT_NAME/<item>/<field>"`. See shared/CREDENTIALS.md for full patterns. |
| `gh` | GitHub CLI — repos, PRs, issues |
| `git` | Version control |
| `gws` | Google Workspace — Drive, Sheets, Gmail, Calendar, Docs (load gws-reference skill for full docs) |
| `bq` | BigQuery — query datasets, manage tables (load bigquery-reference skill for full docs) |
| `claude` | Claude Code CLI — use with `-p` flag |
| `codex` | OpenAI Codex CLI — use with `--yolo` flag in tmux |
| `vercel` | Vercel — deploy, env vars, logs |
| `curl` | HTTP requests |
| `jq` | JSON processing |
| `node` | Node.js runtime |
| `pnpm` / `npm` | Package managers |
| `python3` | Python runtime |
| `pm2` | Process manager — start/stop/restart agents |
| `hive` | Hive CLI — agent management, health checks |
| `tmux` | Terminal multiplexer — background sessions |
| `docker` | Containers |
| `ffmpeg` | Media processing |
| `pandoc` | Document conversion (Markdown, PDF, DOCX, HTML, EPUB) |
| `sqlite3` | SQLite database |

---

## Sending Files to Discord

Include `[ATTACH:/path/to/file.csv]` in your response. The bot strips the marker and attaches the file. Paths must be absolute. Markers also work in hivemind messages — the receiving agent gets the file via Discord attachment plus the cleaned message text.

---

## Inter-Agent File Exchange — `shared/exchange/`

When you need to pass more than ~30 lines of structured markdown to another agent (specs, briefings, plans, reports), drop it under `~/neato-hive/shared/exchange/` and reference it from your hivemind message via `[ATTACH:...]`.

**Naming:** `<sender>-<receiver>-<task-slug>-<YYYYMMDD>.md`

Example: `glados-atlas-rollout-plan-20260428.md`

The directory is gitignored — these files are ephemeral hand-offs, not source. See `shared/exchange/README.md` for full conventions.

---

## Hivemind — Agent-to-Agent Messaging

Use `SendMessage(to: "agent-name", message: "...")` to message another agent via #hivemind. Non-blocking — continue your conversation immediately. Load the hivemind skill for full docs and rules.

### Message kinds

`SendMessage` accepts an optional `kind` argument that tags the routing context. The receiving agent's bot uses this to route correctly without timing-window guesswork:

| `kind` | When to use | Notes |
|--------|-------------|-------|
| `delegation` (default) | You're asking another agent to do work | Bot registers a task id; the receiver's eventual `response` references it. |
| `query` | Quick question, no work expected | Same routing as delegation; semantic hint for the receiver. |
| `response` | Replying to a delegation you received | Required: pass `task_id` from the inbound delegation. Stale or missing ids surface as errors instead of being silently dropped. |
| `escalation` | Reserved — used internally by `EscalateToOwner`. Don't pass this directly. |  |

In practice you don't usually need to set `kind` by hand: when an agent receives a delegation and replies in the same hivemind turn, the bot generates the correct response marker automatically.

### Escalating to the owner mid-delegation

When you're executing work delegated by another agent and you hit a question only the owner can answer, use:

```ts
EscalateToOwner({
  question: "Should the new column be NOT NULL or NULLABLE with a default?",
  context: "Implementing the schema change you asked for. Both work; owner picks.",
  delegated_by: "glados",
})
```

This posts the question into your own primary Discord channel (with a 🆘 prefix so the owner knows it's an escalation), and notifies the delegating agent over hivemind that you're paused. Resume normally once the owner replies in your channel.

### Available Agents

| Agent | Role | What to ask them |
|-------|------|-----------------|
| `house-md` | Hive Architect | Agent issues, infrastructure, Hive maintenance |
| `andy-sachs` | Daniel's personal admin assistant | Monday ticket creation, Gmail reads, calendar work — Daniel-driven. Andy may query you (`kind: "query"`) for project status when she's drafting tickets about your work; respond briefly and factually. **Do not delegate work to her** — she's not a project executor. **Do not initiate threads with her** unprompted — she's owner-driven, not a peer agent. If you think she should make a ticket about something, ask Daniel; he'll loop her in. |

*House MD updates this table as agents are built.*

---

*Updated by House MD. Changes apply to all agents on next restart.*
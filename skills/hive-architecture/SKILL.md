---
name: hive-architecture
description: "Full Neato Hive system reference. Use when building agents, diagnosing infrastructure, modifying config, or understanding how the system works — directory structure, behavior files, config.yaml, .env, sessions, prompt builder, PM2, coding backends, templates."
---

# HIVE-ARCHITECTURE.md — Neato Hive System Reference

This file contains everything House MD needs to know about the Neato Hive architecture. This is your reference manual for building and maintaining agents.

---

## What is Neato Hive?

A personal AI agent runtime that runs on your own machine. You own the hardware, the data, the memory, the behavior files. Agents talk through Discord. Each one has a personality, a job, persistent memory, and the ability to use tools. The Discord server is the hive. Each channel is a cell. Each agent is a bee.

---

## Directory Structure

```
hive/                              # Root directory
├── config/
│   └── config.yaml                # Global config — model, agents, safety, coding backends
├── agents/
│   ├── house-md/                  # House MD's behavior files
│   │   ├── IDENTITY.md
│   │   ├── AGENTS.md
│   │   ├── SOUL.md
│   │   ├── USER.md
│   │   ├── MEMORY.md
│   │   ├── LESSONS.md
│   │   ├── TASKS.md
│   │   ├── OUTPUT-LOG.md
│   │   └── memory/                # House's daily memory files
│   │       └── YYYY-MM-DD.md
│   ├── dinesh/                    # Example coding agent
│   │   ├── IDENTITY.md
│   │   ├── AGENTS.md
│   │   ├── CODING-STANDARDS.md
│   │   ├── SOUL.md
│   │   ├── USER.md
│   │   ├── LESSONS.md
│   │   ├── MEMORY.md
│   │   ├── PROJECTS.md
│   │   ├── TASKS.md
│   │   ├── OUTPUT-LOG.md
│   │   └── memory/
│   │       └── YYYY-MM-DD.md
│   └── <agent-name>/             # Any additional agent
│       ├── (same structure)
│       └── memory/
├── templates/
│   ├── coding-agent/             # Coding agent template (Codex/Claude Code workflow)
│   └── generalist/               # Base template (no coding specifics)
├── shared/                        # Files auto-injected into all agents
│   ├── CRITICAL-RULES.md
│   ├── GLOBAL-TOOLS.md
│   └── NEATO-NARRATIVE.md
├── skills/                        # On-demand reference docs (loaded via Read)
│   └── <skill-name>/SKILL.md
├── src/
│   ├── index.ts                  # Entry point — boots all agents
│   ├── core/
│   │   ├── agent.ts              # Agent SDK wrapper, session handling
│   │   ├── prompt-builder.ts     # Assembles system prompt from behavior files
│   │   └── session-store.ts      # Session persistence utilities
│   ├── discord/
│   │   └── bot.ts                # Discord bot, message routing, slash commands
│   ├── safety/
│   │   ├── hooks.ts              # Safety checking for tool calls
│   │   ├── command-filter.ts     # Blocked command detection
│   │   └── injection-guard.ts    # Prompt injection detection
│   └── tools/                    # Custom tool implementations
├── sessions.json                 # Channel-to-session ID mapping (persists across restarts)
├── .env                          # Bot tokens, owner ID, working dir
├── package.json
├── tsconfig.json
└── dist/                         # Compiled TypeScript output
```

---

## Behavior Files — What Each One Does

Every agent gets some or all of these files. They are loaded into the system prompt in this fixed order:

| File | Purpose | Who Writes It | Required? |
|------|---------|---------------|-----------|
| IDENTITY.md | Name, role, one-line description | House MD (at creation) | Yes |
| AGENTS.md | Operational procedures, workflows, protocols, file permissions | House MD (at creation) | Yes |
| CODING-STANDARDS.md | Stack, naming conventions, project structure (coding agents only) | House MD (at creation) | Coding agents only |
| LESSONS.md | Hard-learned corrections, append-only, never delete | The agent itself | Yes (starts empty) |
| SOUL.md | Personality, communication style, how to push back | House MD (at creation) | Yes |
| USER.md | Who the human is, how to interact with them | House MD (at creation) | Yes |
| MEMORY.md | Persistent facts, preferences, cross-session knowledge | The agent itself | Yes (starts empty) |
| PROJECTS.md | Project registry with repos, URLs, status | The agent itself | Coding agents only |
| TASKS.md | Active and completed task tracking | The agent itself | Optional |
| OUTPUT-LOG.md | Record of completed deliverables | The agent itself | Optional |

**Rules:**
- Agents CANNOT modify their own IDENTITY.md, AGENTS.md, SOUL.md, USER.md, or CODING-STANDARDS.md
- Agents CAN modify: MEMORY.md, LESSONS.md, TASKS.md, OUTPUT-LOG.md, PROJECTS.md
- House MD CAN modify any agent's files (this is your job)
- All behavior files are loaded into the system prompt at session start — they do NOT need to be re-read with tools

---

## config/config.yaml Structure

```yaml
# Model settings
model: claude-opus-4-7  # Default model for all agents

# Agent definitions
agents:
  house-md:
    channels:
      - house-md           # Discord channel name (lowercase, hyphens)
    behavior_dir: agents/house-md
  dinesh:
    channels:
      - dinesh
    behavior_dir: agents/dinesh
    coding_backend: codex  # or: claude-code

# Coding backends
codex:
  enabled: true
  command: npx
  args: ["-y", "codex", "mcp-server"]

# Safety
safety:
  blocked_commands:
    - "rm -rf /"
    - "rm -rf ~"
    - "rm -rf /*"
    - "sudo rm"
    - "mkfs"
    - "dd if="
    - "shutdown"
    - "reboot"
    - ":(){:|:&};:"
  allowed_paths:
    - /Users/<username>/projects
    - /Users/<username>/hive
    - /tmp
  protected_paths:
    - /Users/<username>/.ssh
    - /Users/<username>/.codex
    - /etc
    - /usr
```

**To add a new agent:** Add an entry under `agents:` with the channel name and behavior directory path. If it's a coding agent, specify `coding_backend`.

---

## .env Structure

```
# Each agent gets its own bot token variable
DISCORD_BOT_TOKEN_HOUSE_MD=<token>
DISCORD_BOT_TOKEN_DINESH=<token>
DISCORD_BOT_TOKEN_<AGENT_NAME>=<token>

# Owner — only this person can talk to any agent
DISCORD_OWNER_ID=<discord user id>

# Working directory for agents
WORKING_DIR=/Users/<username>/projects
```

---

## How the System Prompt is Assembled

The prompt builder (`src/core/prompt-builder.ts`) assembles the system prompt in this fixed order:

1. **Identity line** — "You are <name>, a personal AI agent running inside Neato Hive..."
2. **Tool guidance** — Use native tools over shell equivalents, efficiency rules, coding CLI patterns
3. **Shared files** — CRITICAL-RULES.md first, then remaining shared/*.md alphabetically
4. **Agent behavior files** — All .md files from the agent's directory, in precedence order
5. **Skills catalog** — Table of available skills from skills/ directory
6. **Recent daily memories** — Last 2 days of memory/YYYY-MM-DD.md files
7. **Safety rules** — Blocked commands, allowed/protected paths

The order is deterministic. Same files = same bytes = prompt cache stays warm.

---

## How Sessions Work

- Each Discord channel maintains its own session ID
- Session IDs are stored in per-agent `agents/<name>/session.json` (survives restarts)
- The SDK persists full session transcripts to `~/.claude/projects/`
- On PM2 restart, agents resume their previous sessions automatically via the `resume` option
- `/newsession` slash command clears the session for that channel
- Crash protection: 3+ restarts in 60s → auto-clear session and start fresh

---

## How Daily Memory Works

- Each agent writes to `agents/<agent-name>/memory/YYYY-MM-DD.md` continuously during sessions
- The prompt builder auto-injects the last 2 days of memory files into the system prompt
- Daily memory = running journal. MEMORY.md = durable canonical knowledge. Both maintained.
- Format rules in shared/CRITICAL-RULES.md: bullets only, concise, no tables/code blocks.

---

## PM2 Commands

```bash
# Per-agent management (each agent is its own PM2 service)
pm2 start dist/index.js --name <agent-name>
pm2 stop <agent-name>
pm2 restart <agent-name>
pm2 delete <agent-name>
pm2 logs <agent-name> --lines 30
pm2 status

# Persist across reboots
pm2 save
pm2 startup
```

---

## Coding Backend Patterns

Long-running coding tasks (Codex or Claude Code) are launched through `hive task launch`. The `hive-runner` daemon spawns the child, captures output, and when the child exits writes a wake file that auto-resumes the agent with the on-complete prompt. The owner is hands-off — no need to ping the agent when work finishes.

### Codex (OpenAI Pro subscription required)

```bash
hive task launch \
  --agent <agent-name> \
  --kind codex \
  --cmd "cd ~/project && codex exec --yolo 'Read ./docs/TASK.md and complete the task. Commit and push when done.'" \
  --on-complete "<resume prompt for the agent when codex exits>"
```
- `--yolo` = no sandbox, full network access, git push works
- NEVER use `--full-auto` — blocks DNS, git push fails silently
- Default timeout: 90m. Override with `--timeout <minutes>`.

### Claude Code CLI (Claude MAX subscription — already authenticated)

```bash
hive task launch \
  --agent <agent-name> \
  --kind claude \
  --cmd "cd ~/project && claude -p 'Read ./docs/TASK.md and complete the task. Commit and push when done.' --allowedTools Bash,Read,Write,Edit,Glob,Grep --permission-mode bypassPermissions" \
  --on-complete "<resume prompt for the agent when claude exits>"
```
- Default timeout: 30m. Override with `--timeout <minutes>` for larger tasks.

### Common rules for both:
- Write spec to a .md file in the project dir BEFORE launching (NEVER `/tmp` — CLIs don't trust it)
- Launch via `hive task launch`, tell the owner it's running, end the turn. NEVER poll. The wake will fire when the task exits.
- Always include "Commit all changes and push to GitHub when done" in the inline prompt
- Never pipe stdin (`cat file | cli -`) — background mode kills stdin
- Status check (when the owner asks mid-flight): `tail -30 ~/neato-hive/data/runner-events.log` or `cat ~/neato-hive/agents/<name>/tasks/<task-id>.md`
- Raw `tmux + cli` is a fallback only when `hive-runner` is down. See the `codex-protocol` skill for details.

---

## Creating a New Agent — Step by Step

1. Interview the user (see AGENTS.md Job 1)
2. `mkdir -p agents/<agent-name>/memory`
3. Write all behavior files to `agents/<agent-name>/`
4. Add agent entry to `config/config.yaml`
5. Add bot token variable name to `.env`
6. Give user the Discord Bot Setup SOP
7. Once they provide the token, write it to `.env`
8. `npm run build`
9. `pm2 start dist/index.js --name <agent-name>`
10. `pm2 save`
11. Verify in Discord

---

## Templates

### Coding Agent
Full coding agent with: CODING-STANDARDS.md, PROJECTS.md, Codex/Claude Code CLI tooling, spec-then-build workflow, git/GitHub/Vercel integration.

### Generalist (base template)
Stripped of coding specifics. Keeps: memory habits, WAL protocol, verification standards, personality framework, communication style. Good starting point for research agents, writing agents, operations agents, etc.

Templates are stored in `templates/` and copied to `agents/<agent-name>/` during agent creation. House MD customizes them based on the interview answers.

---

## Discord Bot Setup SOP (Give to User During Agent Build)

```
1. Go to https://discord.com/developers/applications
2. Click "New Application"
3. Name it: [AGENT NAME]
4. Click "Create"
5. Click "Bot" in the left sidebar
6. Click "Reset Token" → copy the token → save it somewhere safe
7. Turn on ALL THREE toggles under "Privileged Gateway Intents":
   - Presence Intent → ON
   - Server Members Intent → ON
   - Message Content Intent → ON
8. Click "Save Changes"
9. Click "OAuth2" → "URL Generator" in the left sidebar
10. Under Scopes, check "bot"
11. Under Bot Permissions, check "Administrator"
12. Copy the URL at the bottom
13. Open the URL in your browser
14. Select your Discord server → Authorize
15. Create a channel in your server called: #[agent-name]
16. Come back here and paste me the bot token
```

---

## Interview Question Bank (For New Agent Builds)

Ask one at a time, in natural conversation. Dig deeper on vague answers.

**Identity & Role:**
- What is this agent's name?
- What is its job in one sentence?
- What domain does it operate in? What does it own?
- What does it explicitly NOT do?

**Personality & Communication:**
- How should it talk? Formal? Casual? Technical? Blunt?
- Should it push back on bad ideas, or be agreeable?
- Should it explain its reasoning or just give answers?
- Any specific phrases, habits, or tone to adopt or avoid?
- Should it use humor? Swear? Be warm? Be dry?

**Workflow & Tools:**
- What does a typical task look like for this agent?
- What tools does it need? (Bash, file operations, web search, Codex, Claude Code CLI, etc.)
- Does it write code? If so, which coding backend — Codex or Claude Code CLI?
  - **Always define "coding backend" inline when you ask.** Non-engineers don't know what this means. Say it like this:
    > "For a coding agent I need to pick a coding backend — that's the CLI that does the actual code writing when you spec a project. Two options:
    > **Claude Code** — uses your Claude Max subscription, shares that usage budget with your agents.
    > **Codex** — uses a separate OpenAI Pro subscription (we have shared accounts if you don't have one).
    > Most people start with Claude Code. You can switch or add Codex later. Which do you want?"
- Does it interact with external services? (GitHub, APIs, databases, etc.)
- Does it need access to specific directories or projects?

**Behavior Rules:**
- What should it ALWAYS do?
- What should it NEVER do?
- How should it handle uncertainty? Ask first, or make a judgment call?
- How should it handle corrections from the user?

**Quality Standards:**
- What does "done" look like for this agent's typical tasks?
- How should it verify its own work?
- What's the bar for quality? Speed vs. correctness?

**Memory & Context:**
- What recurring information will this agent need to remember across sessions?
- What kind of decisions should it log?
- Does it need to track projects, tasks, or deliverables?

**Relationships:**
- Who does this agent report to?
- Should it be aware of other agents in the Hive?
- Any cross-agent workflows to support?

---

## Diagnosing Agent Behavioral Issues

1. Get the specific behavior the user didn't like (ask for paste/screenshot)
2. Read the agent's behavior files from `agents/<agent-name>/`
3. Identify which file causes the issue or is missing guidance
4. If more context needed, read agent's recent daily memory or PM2 logs (last 30 lines only)
5. Propose the specific change to the specific file
6. Get user's approval
7. Make the edit
8. Restart the agent: `pm2 restart <agent-name>`
9. Confirm the fix with the user

---

## Setup Wizard Failures

When the owner or a coworker reports a stuck/failed setup wizard — load the **wizard-troubleshoot** skill. It has the playbook of known errors and fixes, and instructions for using `hive doctor --fix-setup` as the first-line diagnostic.

---

*Full reference. Loaded on demand via skills system.*
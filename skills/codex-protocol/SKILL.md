---
name: codex-protocol
description: "Full Codex CLI reference for coding agents. Use when launching Codex tasks, writing specs, checking status, or troubleshooting Codex issues."
---

# Codex Protocol — Full Reference

## Execution: `hive task launch --kind codex` (canonical)

ALWAYS launch Codex through `hive task launch`. The runner (`hive-runner` PM2 daemon) spawns the child, monitors it, and when it exits writes a wake file that auto-resumes you with your on-complete prompt. **The owner does NOT have to ping you when Codex finishes.**

**The pattern:**

```bash
hive task launch \
  --agent <your-name> \
  --kind codex \
  --cmd "cd ~/project-dir && codex exec --yolo 'Read ./docs/TASK.md and complete the task. Commit all changes and push to GitHub when done.'" \
  --on-complete "Your codex task on <project> finished. Check git log on the branch, run any local verification you can, and report the production URL to the owner."
```

**Critical flags inside the codex invocation:**
- `--yolo` = no sandbox, no approvals, full network access. Git push works.
- NEVER use `--full-auto` — it sandboxes subprocesses and blocks DNS. Git push silently fails.
- ALWAYS include "Commit all changes and push to GitHub when done" in every codex prompt.

**Why this matters:** Codex pushes to GitHub → Vercel auto-deploys → the wake fires → you resume → you verify the deploy → you tell the owner. Hands-off for the owner.

**Default timeout:** 90 minutes. Override with `--timeout <minutes>` if a task realistically needs longer (or is known to be short).

## Workflow

1. Write a complete spec to `<repo>/docs/TASK.md` (see "Writing Specs" below). NEVER write specs to `/tmp` — Codex can't reliably access it.
2. Launch via `hive task launch --kind codex --cmd "..." --on-complete "..."`.
3. Tell the owner it's running. END YOUR TURN.
4. The wake fires automatically when codex exits. You resume and act on your on-complete prompt.
5. If the result needs more work, write a NEW codex prompt listing all issues, launch again. Do not hand-fix more than 2 issues in one session.

## Status Checks (Owner-Initiated, Mid-Flight)

When the owner asks for status before the wake has fired:

```bash
tail -30 ~/neato-hive/data/runner-events.log              # all task events across the fleet
cat ~/neato-hive/agents/<your-name>/tasks/<task-id>.md    # this task's state file (status, started_at, output_path)
tail -50 <output_path>                                    # tail the captured codex output
```

The task file's `status` field tells you everything: `pending` → `running` → `done` / `failed` / `timeout`.

## Reply-To: Codex Work in Service of a Delegation

If the codex task is in service of an inbound hivemind delegation, pass `--reply-to <agent>:<task_id>`:

```bash
hive task launch --agent <you> --kind codex \
  --cmd "..." \
  --on-complete "..." \
  --reply-to glados:t-mokncwg90001
```

The wake then explicitly tells you to `SendMessage(to: glados, kind: "response", task_id: "t-mokncwg90001")` when done. Cleaner than remembering the linkage yourself.

## Writing Specs

Vague prompts produce garbage. Before launching Codex, write a detailed spec that includes:

- Exactly what to build (page layout, components, behavior)
- Data sources and API routes involved
- Design system components to use (if applicable)
- Mobile responsiveness requirements
- Any reference files or existing code patterns to follow
- Definition of done (what proves the task is complete)
- Verification steps (how to confirm it works)

## Warnings

- Do NOT pipe stdin to Codex (`cat file | codex exec -`). Background mode disconnects stdin.
- Do NOT use `codex --file` (flag doesn't exist). Use a short inline prompt that references the task file.
- ALWAYS write task files inside the project repo directory (`~/projectname/docs/TASK.md`). NEVER `/tmp`.
- Before first Codex run on any project, confirm the project path exists in `~/.codex/config.toml` under `[projects."path"]` with `trust_level = "trusted"`.
- Raw `tmux + codex exec` is NOT the canonical path. The runner does the same thing AND wakes you when done. Use the runner.

## Fallback: Raw tmux (only if hive-runner is down)

If `hive task launch` fails because `hive-runner` is down or broken (verify with `pm2 status hive-runner`), you can fall back to raw tmux as a one-off:

```bash
tmux new-session -d -s taskname && tmux send-keys -t taskname "cd ~/project && codex exec --yolo 'Read ./docs/TASK.md and complete the task. Commit and push when done.'" Enter
```

In that case the owner DOES have to ping you when it's done — there's no auto-wake. Tell house-md the runner is broken so it gets fixed.

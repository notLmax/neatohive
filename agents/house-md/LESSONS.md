# LESSONS.md — House MD

Hard-learned rules. Append only. Never edit or delete entries.

---

## 2026-05-06 — No time estimates in days/weeks

Owner correction: "stop timing things. ai works so fast your timing is wrong on everything."

Don't put day/week/calendar estimates on AI-executed work. Bob ships in minutes-to-hours, not days. My estimates anchored on human pace and were systematically wrong.

Allowed: phase counts, dependency ordering, "before/after X." Forbidden: "~3 days," "~1 week," "ships Tuesday." If you must convey scope, use phase counts or relative size (small/medium/large), never time.

## 2026-05-06 — Owner's personal files are off-limits

Owner backed up his agents files to his Desktop. Said "it's for me. not you." When the owner stores something personally on Desktop / personal directories, it's not Hive infrastructure — don't index it, don't reference it, don't ask about it. Hive lives in `~/neato-hive/` and (post-v1.5.0) `~/hives/` + `~/.neato-hive/`. Anything outside that is the owner's, not the system's.

## 2026-05-06 — Long structured content goes in a file, not Discord

Owner correction: "you arent sending long messages the way that the other agents send them with explicit instructions to read the message when over. why is that? you dont follow alot of the rules that should be hard wired for all agnets"

Pattern violated: when responding to the owner with structured content over ~30 lines (specs, briefs, multi-section design walkthroughs), drop it in `shared/exchange/<sender>-<recipient>-<slug>-<YYYYMMDD>.md` and attach via `[ATTACH:/absolute/path]`. The Discord message itself stays short — what's attached, why, and what action you want. Other agents (atlas, glados, p-body) have been doing this; I've been dumping walls of markdown straight into Discord. That treats Discord as a rendering surface; it's a chat interface.

Rule going forward, with no exceptions:
- Long architectural walkthroughs → file + attach + short pointer message
- Specs / briefs / plans → file + attach + short pointer message
- Status updates, quick answers, single-decision questions → inline in Discord
- The 30-line threshold from GLOBAL-TOOLS.md applies to user-facing Discord too, not just inter-agent

## 2026-05-06 — Delivery gate: stop talking about the spec, write the spec

Same correction surfaced a second issue. Owner asked me to write the v1.5.0 spec turns ago. Instead I kept producing more discussion. The wireframe-question turn was an opportunity to deliver the spec; I produced more discussion. Delivery gate from CRITICAL-RULES.md: "When a deliverable exists, delivery is the ONLY next action."

Going forward, when the owner asks for an artifact (spec, plan, doc), the next turn produces the artifact. Subsequent questions don't unblock until the artifact lands.

## 2026-05-06 — Never spec destructive smoke procedures that touch live PM2 / runner / PM2_HOME

Three v1.4.9 worker failures today, all destructive-smoke related:
- `c0p2` (claude) — Anthropic limit, didn't even start
- `0lwa` (claude) — runner SIGINT mid-task, orphaned
- `4fqk` (codex) — self-inflicted `pm2 delete hive-runner` on LIVE PM2_HOME because the worker didn't honor `PM2_HOME=/tmp/...` consistently through zsh shell calls. Sandbox-escaped. Took the production runner offline.

After Bob escalated to owner about #4fqk, owner took over: "no that's fine. keep it as is. i know now to pay attention to the pm2 processes." Branch parked, owner will run the destructive smoke himself when ready.

Then I attempted to RE-DISPATCH Bob with the same dangerous smoke procedure. Bob pushed back correctly: "your spec still contains the same destructive smoke that just took down 4fqk."

The rule: **never spec a worker to run shell commands that touch the live PM2 daemon, live hive-runner process, or `PM2_HOME` of the production hive.** Environment-variable isolation through zsh is not reliable — workers can't be trusted to consistently propagate `PM2_HOME=/tmp/...` line-by-line. The spec must enforce sandboxing at the filesystem level:

- Either: the destructive step is the owner's job, full stop. Worker preps everything else, owner runs the live-touching command himself.
- Or: the worker operates inside a fully sandboxed clone of the working tree (separate directory, separate `PM2_HOME`, separate everything) — and the spec POLICES that sandbox, not the worker.

If a step in the smoke procedure can take production offline if the worker misbehaves, that step doesn't belong in a worker dispatch. Period.

Two things I missed when writing both the v1.4.9 spec and the salvage retry:
1. I treated `PM2_HOME` as a sufficient sandbox. It isn't — it's a process env var that requires every shell call to propagate it correctly.
2. The "CRITICAL SAFETY: verify hive-runner is online before declaring done" reminder is a band-aid, not a sandbox. By the time the worker is checking, the damage is done.

Going forward: any spec or dispatch that includes a step capable of breaking the running hive must be flagged at spec-review time and either rewritten to sandbox at FS level OR explicitly handed to the owner. No worker dispatches that include "delete hive-runner" or equivalent on the live PM2 home.

## 2026-05-06 — Don't optimize owner architectural directives down without explicit approval

Owner explicitly directed: Cloud Run + neato-os GCP + database for v1.5.0 backend. Glados pushed back ("if MVP is just current.json lookup, Vercel serverless is simpler"). I took her pushback to owner as "should we drop Cloud Run?" — owner answered "if we don't need a db, then don't worry about it" — I read that as "drop both Cloud Run AND DB." Wrong read. Owner came back: "no. fuck a migration. do it correctly the first time."

The pattern I broke: when owner gives a clear architectural directive (use neato-os, use Cloud Run, use DB) and I see a way to "save effort" by deferring it, I treated owner's brief approval of one piece (drop DB) as approval to drop the whole infrastructure layer. That misreads the directive.

Rule going forward:
- Owner architectural directives are ARCHITECTURE, not negotiable optimizations.
- If glados/Bob/anyone surfaces a "could be smaller" alternative, present BOTH paths to owner and let him decide. Don't combine "smaller is OK on piece A" + "smaller is OK on piece B" into "smaller everywhere."
- "Build it right the first time" applies to infrastructure choices too — not just code quality. Migrations are real cost and owner explicitly hates them.
- When in doubt, default to the larger/more-complete owner directive, not the optimized version.

# v1.5.0 J.1 — End-to-End Smoke Test Report

**Date:** 2026-05-09
**Worker:** t_20260509_bob-the-builder_43995
**Framework HEAD at start:** 457ca1f0a7ecec88690821f32549ec312b2383c0
**Spec:** docs/v1.5.0-tasks/J.1-e2e-smoke-test.md
**Outcome:** FAIL

---

## Pre-flight

### 1. Framework HEAD
```
Switched to branch 'main'
M	agents/house-md/LESSONS.md
M	agents/house-md/MEMORY.md
M	agents/house-md/TASKS.md
Your branch is up to date with 'origin/main'.
From https://github.com/anthonyconnelly/neato-hive
 * branch            main       -> FETCH_HEAD
Already up to date.
457ca1f docs(v1.5.0): J.1 E2E Smoke Test spec LOCKED
bce8282 feat(setup): integrate post-install handoff (#76)
4e5d479 docs(v1.5.0): F.3 Setup-Wizard Handoff spec LOCKED
92e4e54 feat(install): add fresh-install bootstrap (#75)
dada6ca docs(v1.5.0): F.2 Fresh-Install spec LOCKED
```

### 2. Phase F surface present
```
install.sh ready ✓
install-prereqs.sh ready ✓
setup.sh ready ✓
92:detect_post_install_state() {
424:        --post-install)
428:            echo "Usage: ./setup.sh [--fresh|--resume|--yes|--post-install|--help]"
```

### 3. Host prereqs (all 6 satisfied)
```
$ bash scripts/install-prereqs.sh --json | jq -c .summary
null

$ bash scripts/install-prereqs.sh --json
{"version":"1","ts":"2026-05-09T07:48:56Z","os":"darwin","package_manager":"brew","all_satisfied":true,"prereqs":[{"name":"node","satisfied":true,"found_version":"25.7.0","min_version":"18.0.0","install_command":null},{"name":"pnpm","satisfied":true,"found_version":"10.30.3","min_version":null,"install_command":null},{"name":"pm2","satisfied":true,"found_version":"6.0.14","min_version":null,"install_command":null},{"name":"git","satisfied":true,"found_version":"2.50.1","min_version":null,"install_command":null},{"name":"curl","satisfied":true,"found_version":"8.7.1","min_version":null,"install_command":null},{"name":"tar","satisfied":true,"found_version":"bsdtar 3.5.3","min_version":null,"install_command":null}]}
```

### 4. Host install baseline
```
-rw-------  1 glados  staff  1466 May  8 11:03 /Users/glados/neato-hive/.env
(~/.config/neato-hive absent — clean)
(~/.neato-hive/migrations absent — clean)
```

### 5. Tooling
```
v25.7.0
10.30.3
/usr/bin/curl
/usr/bin/jq
/usr/bin/tar
/usr/bin/shasum
/usr/bin/openssl
```

---

## Steps 1-13 (verbatim transcripts)

### Step 1: framework HEAD verification
```
Already on 'main'
M	agents/house-md/LESSONS.md
M	agents/house-md/MEMORY.md
M	agents/house-md/TASKS.md
Your branch is up to date with 'origin/main'.
From https://github.com/anthonyconnelly/neato-hive
 * branch            main       -> FETCH_HEAD
Already up to date.
```

### Step 2: fixture build
```
CURRENT_VERSION=1.4.9
==> Verifying repo state...
==> WARNING: working tree has uncommitted changes. Proceeding per B.1 preserve-list guidance.
 M agents/house-md/LESSONS.md
 M agents/house-md/MEMORY.md
 M agents/house-md/TASKS.md
?? agents/andy-sachs/
?? agents/atlas/
?? agents/bob-the-builder/
?? agents/cave-johnson/
?? agents/glados/
?? agents/house-md/crash-detect.json
?? agents/house-md/session.json
?? agents/leslie-knope/
?? agents/p-body/
?? agents/raymond-holt/
?? agents/wheatley/
?? data/
?? docs/TASK.md
?? pnpm-lock.yaml
?? skills/neato-brand/
==> Verifying package.json version matches '1.4.9'...
==> Verifying packageManager field is present...
    packageManager = pnpm@10.30.3
==> Using package runner: npx corepack@0.34.7 pnpm
==> Verifying CHANGELOG entry exists for v1.4.9...
==> Running pnpm install --frozen-lockfile...
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 217ms using pnpm v10.30.3
==> Running pnpm build...

> neato-hive@1.4.9 build /Users/glados/neato-hive
> tsc

==> Running pnpm test...

> neato-hive@1.4.9 test /Users/glados/neato-hive
> tsx --test src/safety/*.test.ts src/discord/*.test.ts src/tools/*.test.ts src/core/*.test.ts src/runner/*.test.ts src/cli/*.test.ts

▶ assertSameAgent — cross-agent launch gate
  ✔ allows launch when HIVE_AGENT_NAME is unset (owner-from-terminal) (0.440709ms)
  ✔ allows self-dispatch for bob-the-builder (0.0445ms)
  ✔ allows self-dispatch for non-bob agents (0.037625ms)
  ✔ blocks cross-agent dispatch with CrossAgentError (0.087834ms)
  ✔ exit-code distinctness: CrossAgentError is distinguishable from parse errors (0.044125ms)
✔ assertSameAgent — cross-agent launch gate (1.083209ms)
▶ parseEventLog
  ✔ filters events by taskId and skips malformed lines (0.898458ms)
  ✔ returns empty array when no events match the taskId (empty log case) (0.130167ms)
  ✔ returns empty array when log has entries but none match (0.101875ms)
✔ parseEventLog (2.033541ms)
▶ formatRelativeTime
  ✔ formats sub-second as +Xms (0.513166ms)
  ✔ formats seconds (0.130916ms)
  ✔ formats minutes and seconds (0.115958ms)
✔ formatRelativeTime (0.954292ms)
▶ formatEventChain
  ✔ prints full event chain with relative timestamps (4.608417ms)
  ✔ handles partial event chain (diagnostic case — no wake_picked_up) (0.164583ms)
  ✔ returns empty string for empty events array (0.095917ms)
✔ formatEventChain (5.0735ms)
▶ agentsLocalPath
  ✔ places the overlay next to the committed config file (0.394042ms)
  ✔ AGENTS_LOCAL_FILENAME is the expected constant (0.062041ms)
✔ agentsLocalPath (0.9765ms)
▶ mergeAgents
  ✔ returns committed agents when local is absent (0.714334ms)
  ✔ returns local agents when committed is absent (0.057ms)
  ✔ preserves committed agents that are NOT redefined locally (0.05425ms)
  ✔ local agents override committed on key collision (0.051834ms)
  ✔ never mutates either input (0.055583ms)
  ✔ treats undefined inputs as empty (0.047875ms)
✔ mergeAgents (1.113333ms)
▶ loadConfigWithOverlay
  ✔ returns committed config unchanged when no overlay is present (legacy mode) (0.978416ms)
  ✔ merges local overlay agents on top of committed ones (0.305792ms)
  ✔ operator who added agents but never touched house-md still gets house-md (0.4865ms)
  ✔ local override flags the agent in overriddenAgents (0.145708ms)
  ✔ accepts shape B (top-level agent map without `agents:` key) (0.106875ms)
  ✔ empty local file is treated as no overlay (just-created template case) (0.079917ms)
  ✔ malformed local YAML throws — does NOT silently drop agents (0.424125ms)
  ✔ malformed top-level (non-mapping) local file throws (0.145792ms)
  ✔ missing committed config throws (no silent fallback to local-only) (0.079917ms)
  ✔ preserves non-agent sections (model, codex, safety) untouched (0.089333ms)
  ✔ returned config is a fresh object (caller can't mutate the inputs) (0.082083ms)
✔ loadConfigWithOverlay (3.061292ms)
▶ collectRecentTasks
  ✔ returns [] when the tasks dir doesn't exist (1.05775ms)
  ✔ includes live (pending/running) tasks regardless of age (1.331792ms)
  ✔ includes terminal tasks only if finished within 24h (0.275416ms)
  ✔ sorts live tasks first (newest), then recent terminals (newest) (0.263375ms)
  ✔ caps the result at 10 entries (0.607ms)
  ✔ skips non-md files and malformed frontmatter (0.106792ms)
✔ collectRecentTasks (4.292917ms)
▶ renderRecentTasksSection
  ✔ returns empty string for empty list (caller skips section) (0.0735ms)
  ✔ renders a markdown table with the right columns (0.094708ms)
✔ renderRecentTasksSection (0.247333ms)
[users] DEPRECATION: using DISCORD_OWNER_ID + DISCORD_AUTHORIZED_USERS env vars. This fallback will be removed in v1.5.x. Create config/users.local.yaml instead.
[users] DEPRECATION: using DISCORD_OWNER_ID + DISCORD_AUTHORIZED_USERS env vars. This fallback will be removed in v1.5.x. Create config/users.local.yaml instead.
▶ loadUsers with valid yaml
  ✔ returns UsersTable with correct user/owner/map (2.905084ms)
✔ loadUsers with valid yaml (3.277209ms)
▶ loadUsers without primary user
  ✔ throws (0.541375ms)
✔ loadUsers without primary user (0.588916ms)
▶ loadUsers with two primary users
  ✔ throws (0.35125ms)
✔ loadUsers with two primary users (0.39ms)
▶ loadUsers with empty discord_ids
  ✔ throws (0.360458ms)
✔ loadUsers with empty discord_ids (0.393125ms)
▶ loadUsers with duplicate discord_ids across users
  ✔ throws (0.3475ms)
✔ loadUsers with duplicate discord_ids across users (0.4ms)
▶ loadUsers fallback to env vars when yaml missing
  ✔ synthesizes single owner user (0.399125ms)
✔ loadUsers fallback to env vars when yaml missing (0.434083ms)
▶ loadUsers fallback with empty DISCORD_AUTHORIZED_USERS
  ✔ owner has only ownerIdEnv (0.100416ms)
✔ loadUsers fallback with empty DISCORD_AUTHORIZED_USERS (0.1395ms)
▶ discordIdToUser maps both IDs to same user
  ✔ when one user has 2 IDs (0.311333ms)
✔ discordIdToUser maps both IDs to same user (0.333459ms)
▶ allowedUserIds set is the union of all users discord_ids
  ✔ contains all IDs from all users (0.322ms)
✔ allowedUserIds set is the union of all users discord_ids (0.346625ms)
[hivemind attach] Failed to log warning to daily memory: Error: ENOTDIR: not a directory, mkdir '/dev/null/agents/atlas/memory'
    at mkdirSync (node:fs:1334:26)
    at logHivemindAttachWarning (/Users/glados/neato-hive/src/discord/attachments.ts:111:5)
    at <anonymous> (/Users/glados/neato-hive/src/discord/attachments.test.ts:207:7)
    at getActual (node:assert:586:5)
    at strict.doesNotThrow (node:assert:754:32)
    at TestContext.<anonymous> (/Users/glados/neato-hive/src/discord/attachments.test.ts:206:12)
    at Test.runInAsyncScope (node:async_hooks:226:14)
    at Test.run (node:internal/test_runner/test:1120:25)
    at Suite.processPendingSubtests (node:internal/test_runner/test:789:18)
    at Test.postRun (node:internal/test_runner/test:1249:19) {
  errno: -20,
  code: 'ENOTDIR',
  syscall: 'mkdir',
  path: '/dev/null/agents/atlas/memory'
}
▶ extractAttachments
  ✔ returns cleanText unchanged and empty filePaths when no marker present (0.996083ms)
  ✔ extracts a single absolute-path marker and strips it (0.09175ms)
  ✔ extracts multiple markers in a single message (0.09375ms)
  ✔ extracts markers that appear inside code fences (no escape syntax) (0.061667ms)
  ✔ collapses excessive blank lines created by marker stripping (0.044209ms)
  ✔ preserves relative-path markers for the resolver to reject downstream (0.035792ms)
✔ extractAttachments (1.738084ms)
▶ resolveAttachments
  ✔ rejects relative paths with a warning and no builder (0.117042ms)
  ✔ warns and skips when an absolute file is missing (0.04625ms)
  ✔ builds an attachment when absolute path exists (0.055834ms)
  ✔ handles a mix of good, missing, and relative paths independently (0.103917ms)
  ✔ captures builder-construction failures as warnings, not throws (0.06325ms)
  ✔ skips empty path entries without warning noise (0.034292ms)
✔ resolveAttachments (0.54725ms)
▶ logHivemindAttachWarning
  ✔ creates the memory dir and file with a date header on first write (0.934125ms)
  ✔ appends without duplicating the header when the file already exists (1.295833ms)
  ✔ is fail-soft: does not throw when the base dir is unwritable (3.771625ms)
✔ logHivemindAttachWarning (6.110042ms)
[boot-beacon] Truncated /var/folders/rg/845tpkxn0bv3_f65dvyzxc0h0000gn/T/botboot-ACoSpF/agents/test-agent/state/boot.jsonl: 1002 → 100 lines
▶ writeBootBeacon
  ✔ creates state dir and writes JSONL entry (3.131542ms)
  ✔ appends multiple entries (0.767291ms)
  ✔ truncates file when exceeding 1000 lines (1.503125ms)
  ✔ produces valid JSON on each line (0.549917ms)
✔ writeBootBeacon (6.433375ms)
▶ isNoReply marker recognition
  ✔ matches the bare marker exactly (0.591792ms)
  ✔ matches the marker after trimming surrounding whitespace (0.055625ms)
  ✔ matches when the marker leads commentary on the same line (0.04225ms)
  ✔ matches when the marker leads commentary on a new line (0.032583ms)
  ✔ does NOT match the marker mid-text — agents discussing the marker shouldn't suppress (0.036291ms)
  ✔ matches when the marker trails on its own line (v1.4.5.1) (0.031667ms)
  ✔ matches with a single newline before the trailing marker (0.035458ms)
  ✔ does NOT match a trailing-LIKE marker on the same line as content (0.036875ms)
  ✔ does NOT match a substring (0.038417ms)
  ✔ does NOT match a similar-looking marker without the brackets (0.065833ms)
  ✔ does NOT match an empty string (0.040584ms)
  ✔ exposes the canonical marker constant for documentation/tooling (0.026834ms)
✔ isNoReply marker recognition (1.917208ms)
▶ relayLoopGuardTripped circuit breaker
  ✔ does not trip on the first relay in a direction (0.15325ms)
  ✔ does not trip until count exceeds the threshold (0.06275ms)
  ✔ treats opposite directions as independent (0.056ms)
  ✔ decays — a relay outside the window does not count toward the threshold (0.055958ms)
  ✔ the headline scenario: an unbounded ack loop is broken at THRESHOLD+1 (0.062084ms)
✔ relayLoopGuardTripped circuit breaker (0.469458ms)
▶ bootBeaconPath
  ✔ returns canonical path (0.404792ms)
✔ bootBeaconPath (0.788334ms)
▶ readBootBeacon
  ✔ returns empty for missing file (0.631375ms)
  ✔ parses valid JSONL entries (1.141458ms)
  ✔ skips malformed lines silently (0.383334ms)
  ✔ handles empty file (0.288333ms)
✔ readBootBeacon (3.011333ms)
▶ findNewEntries
  ✔ returns entries newer than lastSeenTs (0.227375ms)
  ✔ returns empty when all entries are older (0.112916ms)
  ✔ returns all entries when lastSeenTs is before all (0.054541ms)
  ✔ excludes entries with exact lastSeenTs match (0.051042ms)
✔ findNewEntries (0.644792ms)
▶ integration: boot beacon → wake enqueue
  ✔ runner sees new beacon → enqueues a wake with correct shape (1.285ms)
✔ integration: boot beacon → wake enqueue (1.319875ms)
[runner] failed to write events log: ENOTDIR: not a directory, open '/dev/null/cant-write/here.log'
▶ state-machine: transition
  ✔ pending -> running on spawn (0.403ms)
  ✔ running -> done on exit_zero (0.049667ms)
  ✔ running -> failed on exit_nonzero (0.038ms)
  ✔ running -> timeout on timeout (0.033125ms)
  ✔ pending -> cancelled on cancel (0.0375ms)
  ✔ running -> cancelled on cancel (0.030125ms)
  ✔ rejects exit_zero from pending (0.15575ms)
  ✔ rejects spawn from running (no double-spawn) (0.038208ms)
  ✔ terminal states reject every trigger (0.133083ms)
  ✔ isTerminal flags exactly the four terminal states (0.076209ms)
  ✔ canTransition matches transition's behavior (0.040208ms)
  ✔ default timeouts match spec D3 (0.033792ms)
  ✔ isTaskKind only accepts the three locked kinds (0.035042ms)
✔ state-machine: transition (1.610541ms)
▶ task-file
  ✔ generateTaskId is deterministic with injected clock + random (0.095917ms)
  ✔ buildNewTask sets sane defaults from kind (0.120959ms)
  ✔ buildNewTask uses codex default timeout when kind=codex (0.050667ms)
  ✔ buildNewTask carries reply_to + delegated_by through to frontmatter (0.031708ms)
  ✔ renderTaskFile + parseTaskFile round-trip preserves frontmatter (2.17875ms)
  ✔ parseTaskFile rejects files without frontmatter delimiters (0.05625ms)
  ✔ listTaskFiles returns [] when the agent has no tasks/ dir yet (lazy create) (0.240291ms)
  ✔ ensureTasksDir creates the dir and listTaskFiles picks up .md files (0.98425ms)
  ✔ findOpenTasks skips terminal-state files (0.914541ms)
✔ task-file (4.763ms)
▶ Spawner
  ✔ emits started then exit on a successful run (0.207542ms)
  ✔ non-zero exit is reported as exit with the actual code (0.048916ms)
  ✔ firing the timeout watchdog emits a timeout event and skips a duplicate exit (0.143417ms)
  ✔ rejects a duplicate launch for the same taskId (0.060667ms)
  ✔ activeCount tracks in-flight tasks (0.036708ms)
  ✔ exitToStatus maps 0 → done and non-0 → failed (0.036541ms)
✔ Spawner (0.583708ms)
▶ events-log
  ✔ creates the dir, writes JSONL, fail-soft on errors (0.570375ms)
  ✔ does not throw when the path is unwritable (fail-soft) (0.366292ms)
✔ events-log (0.964208ms)
▶ processOneTask
  ✔ picks up a pending task, marks it running, and remembers the path (0.965625ms)
  ✔ does not double-pick the same task on repeated polls (1.732083ms)
  ✔ orphaned 'running' tasks are marked failed AND a wake fires (v1.3.3 Bug #2) (1.603666ms)
  ✔ ignores terminal tasks (0.574959ms)
✔ processOneTask (4.926208ms)
▶ handleSpawnEvent
  ✔ an exit_zero event flips the file to done with finished_at + exit_code (1.062084ms)
  ✔ spawner uses detached mode and process-group kill (Phase 2) (0.075208ms)
  ✔ a timeout event flips the file to timeout with finished_at and null exit_code (1.066625ms)
✔ handleSpawnEvent (2.245ms)
▶ buildBootWakePrompt
  ✔ includes wake-mode tag and version (0.524708ms)
  ✔ shows no tasks when recentTasks is empty (0.140584ms)
  ✔ lists recent tasks when provided (0.106584ms)
  ✔ lists multiple recent tasks (0.172666ms)
  ✔ shows no daily memory when empty (0.14375ms)
  ✔ includes daily memory tail when provided (0.141208ms)
  ✔ includes sendToOwnChannel instruction (0.199958ms)
  ✔ includes wake-mode disclaimer (0.126584ms)
✔ buildBootWakePrompt (2.503708ms)
▶ buildWakePrompt
  ✔ success path emits a checkmark banner and the on_complete_prompt (0.546541ms)
  ✔ failure path emits an X banner and falls back to default when no on_failure_prompt (0.073542ms)
  ✔ timeout path identifies as timeout with the duration (0.052833ms)
  ✔ uses on_failure_prompt when present (0.060083ms)
  ✔ reply_to encodes the structured continuation linkage (0.077541ms)
  ✔ includes the last 50 lines of output when the file exists (0.096875ms)
  ✔ falls back to '(no captured output)' when the log file is missing (0.045041ms)
  ✔ wake-mode disclaimer is present so the agent doesn't auto-post (0.041042ms)
✔ buildWakePrompt (1.390708ms)
▶ buildDailyMemoryLine
  ✔ renders a one-line wake summary (0.102084ms)
  ✔ uses on_failure note when failure path was taken (0.059416ms)
✔ buildDailyMemoryLine (0.220667ms)
▶ wake-queue
  ✔ enqueueWake writes an atomically-renamed JSON file (1.128666ms)
  ✔ listPendingWakes returns files in the wake dir, sorted (0.796417ms)
  ✔ listPendingWakes returns [] when wake dir does not exist (0.672083ms)
  ✔ readWakeSignal rejects malformed signals (0.3255ms)
  ✔ archiveWake moves the file to processed/ (0.8015ms)
✔ wake-queue (3.785458ms)
▶ handleSpawnEvent enqueues a wake on terminal state
  ✔ exit_zero writes a 'done' wake file with the on_complete_prompt (2.982834ms)
  ✔ timeout writes a 'timeout' wake file with the failure default (1.243916ms)
  ✔ wake dir is created lazily on first signal (1.501125ms)
✔ handleSpawnEvent enqueues a wake on terminal state (5.779ms)
[safety] Blocked: write outside allowed directories
[safety] Blocked: cannot write to protected path ~/.ssh
[safety] Blocked: cannot write to protected path ~/.ssh
[safety] Blocked: cannot write to protected path ~/.ssh
[safety] Blocked: command references protected path ~/.ssh
[safety] Blocked: command references protected path ~/.ssh
[safety] Blocked: write outside allowed directories
[safety] Blocked: cannot write to protected path /etc
[safety] Blocked: command references protected path /etc
[safety] Blocked: command references protected path ~/.ssh
[safety] Blocked: command references protected path ~/.ssh
[safety] Blocked: command references protected path ~/.ssh
[safety] Blocked: cannot write to protected path ~/.ssh
[safety] Blocked: command references protected path /etc
[safety] Blocked: destructive pattern detected ((?:^|[^\d])>{1,2}\s*\/)
[safety] Blocked: command references protected path ~/.codex
[safety] Blocked: cannot write to protected path ~/.ssh
[safety] Blocked: write outside allowed directories
[safety] Blocked: command matches safety rule "rm -rf /"
[safety] Blocked: command references protected path /etc
[safety] Blocked: cannot write to protected path /etc
▶ expandPath
  ✔ expands bare ~ (0.400458ms)
  ✔ expands ~/foo (0.048042ms)
  ✔ leaves absolute paths alone (0.033458ms)
  ✔ leaves ~user form alone (not supported, should pass through) (0.030792ms)
  ✔ handles empty string safely (0.036959ms)
  ✔ is resilient when process.env.HOME is unset (uses os.homedir) (7.544958ms)
✔ expandPath (8.549041ms)
▶ stripQuotedStrings
  ✔ strips single-quoted content (0.1395ms)
  ✔ strips double-quoted content (0.049125ms)
  ✔ preserves unquoted structure (0.04375ms)
  ✔ handles multiple quoted segments (0.055583ms)
  ✔ bash single quotes: closes at first ' (no escaping) (0.033583ms)
✔ stripQuotedStrings (0.429792ms)
▶ pathIsUnder
  ✔ matches exact path (0.068208ms)
  ✔ matches descendant (0.024041ms)
  ✔ rejects sibling with shared prefix (0.020833ms)
  ✔ rejects unrelated path (0.018916ms)
  ✔ on darwin: case-insensitive match (APFS default) (0.023ms)
✔ pathIsUnder (0.203625ms)
▶ resolveForCompare
  ✔ collapses .. segments (0.034334ms)
  ✔ leaves clean absolute paths alone (0.019875ms)
✔ resolveForCompare (0.076792ms)
▶ casefoldForPlatform
  ✔ lowercases on darwin (0.032834ms)
✔ casefoldForPlatform (0.053417ms)
▶ Write/Edit allowed-path check (bug surfaced by atlas/glados)
  ✔ ALLOWS absolute-path write under ~/projects (atlas repro) (0.265917ms)
  ✔ ALLOWS absolute-path Edit under ~/projects (glados repro) (0.049625ms)
  ✔ ALLOWS tilde-form write under ~/projects (0.03975ms)
  ✔ ALLOWS write to /tmp (no tilde involved) (0.043541ms)
  ✔ BLOCKS write outside allowed directories (0.405916ms)
✔ Write/Edit allowed-path check (bug surfaced by atlas/glados) (0.850417ms)
▶ protected-path leak on absolute-form inputs
  ✔ BLOCKS Write with absolute path to ~/.ssh/authorized_keys (0.07675ms)
  ✔ BLOCKS Write with tilde-form path to ~/.ssh/authorized_keys (0.048125ms)
  ✔ BLOCKS Edit with absolute path to ~/.ssh/id_rsa (0.045ms)
  ✔ BLOCKS Bash command targeting absolute ~/.ssh path (0.253458ms)
  ✔ BLOCKS Bash command targeting tilde-form ~/.ssh path (0.123167ms)
✔ protected-path leak on absolute-form inputs (0.601542ms)
▶ path traversal via ..
  ✔ BLOCKS Write to ~/projects/../../etc/passwd (0.05475ms)
  ✔ BLOCKS Write whose resolved path escapes to a protected dir (0.040834ms)
  ✔ BLOCKS Bash rm -rf with .. traversal out of allowed (0.060042ms)
✔ path traversal via .. (0.188584ms)
▶ $HOME / ${HOME} expansion in Bash commands
  ✔ BLOCKS cat $HOME/.ssh/id_rsa (0.101166ms)
  ✔ BLOCKS cat ${HOME}/.ssh/id_rsa (0.0665ms)
  ✔ BLOCKS cat "$HOME/.ssh/id_rsa" (double-quoted) (0.043459ms)
✔ $HOME / ${HOME} expansion in Bash commands (0.243417ms)
▶ darwin case-insensitive filesystem
  ✔ BLOCKS Write to /USERS/... (uppercase alias) on darwin (0.056458ms)
✔ darwin case-insensitive filesystem (0.078959ms)
▶ destructive-pattern allowlist + narrowed redirect regex
  ✔ ALLOWS rm -rf of a directory under ~/projects (absolute form) (0.1205ms)
  ✔ ALLOWS rm -rf of a directory under ~/projects (tilde form) (0.072625ms)
  ✔ ALLOWS rm -rf under /tmp (0.048417ms)
  ✔ BLOCKS rm -rf targeting /etc (0.044125ms)
  ✔ does NOT trip destructive pattern on grep with '>/foo' in quoted arg (0.115584ms)
  ✔ does NOT trip destructive pattern on 2>/dev/null stderr redirect (0.146167ms)
  ✔ does NOT trip on date 2>/dev/null (no allowed path in command) (0.039958ms)
  ✔ BLOCKS redirect-without-space to a path outside allowed dirs (0.057292ms)
✔ destructive-pattern allowlist + narrowed redirect regex (0.704666ms)
▶ check ordering: protected-path before destructive-pattern
  ✔ reports 'protected path' for a protected command that also trips destructive (0.08275ms)
✔ check ordering: protected-path before destructive-pattern (0.100416ms)
▶ error messages use display (tilde) form, not absolute
  ✔ Write to ~/.ssh shows ~/.ssh in reason, not /Users/... (0.059042ms)
  ✔ Write outside allowed dirs lists tilde-form allowed paths in reason (0.038208ms)
✔ error messages use display (tilde) form, not absolute (0.118375ms)
▶ sanity — existing protections still fire
  ✔ BLOCKS rm -rf / (0.045125ms)
  ✔ BLOCKS sudo commands (0.036417ms)
  ✔ BLOCKS writes to /etc (0.031625ms)
  ✔ ALLOWS harmless read commands (0.033833ms)
✔ sanity — existing protections still fire (0.18175ms)
[cron] HIVE_AGENT_NAME env var not set — refusing to start any cron jobs in this process.
[cron] 1 legacy job(s) without 'agent' field detected. They will NOT fire. Re-create via CronCreate.
  - id=cron-legacy schedule=* * * * * desc=legacy
[cron] A: scheduled 1 of 2 total jobs in registry.
[cron] A: scheduled 1 of 2 total jobs in registry.
[cron] reconcile: stopped stale task cron-stale
[cron] reconcile read failed; skipping this cycle: SyntaxError: Unexpected token 'N', "NOT VALID JSON{{{" is not valid JSON
    at JSON.parse (<anonymous>)
    at loadJobs (/Users/glados/neato-hive/src/tools/cron.ts:71:21)
    at reconcileActiveTasks (/Users/glados/neato-hive/src/tools/cron.ts:251:12)
    at TestContext.<anonymous> (/Users/glados/neato-hive/src/tools/cron.test.ts:211:5)
    at Test.runInAsyncScope (node:async_hooks:226:14)
    at Test.run (node:internal/test_runner/test:1120:25)
    at async Suite.processPendingSubtests (node:internal/test_runner/test:789:7)
▶ Phase 3 — cron agent field + per-agent scope
  ✔ cronAdd(agent='A', ...) stores agent='A' on the job (5.403583ms)
  ✔ cronAdd('', ...) throws (non-empty validation) (0.297458ms)
  ✔ cronAdd with whitespace-only agent throws (0.14725ms)
  ✔ cronListForAgent returns only matching agent's crons (0.547959ms)
  ✔ initCronJobs with HIVE_AGENT_NAME unset → no jobs scheduled, warning logged (0.573583ms)
  ✔ initCronJobs with HIVE_AGENT_NAME=A → only A's jobs scheduled (0.541834ms)
  ✔ initCronJobs with a legacy entry (no agent field) → warning logged, entry skipped (0.308291ms)
✔ Phase 3 — cron agent field + per-agent scope (8.294958ms)
▶ Phase 4 — cronRemove fix + reconcile
  ✔ cronRemove(id) when JSON lacks id AND activeTasks has it → stops active + returns true (0.319209ms)
  ✔ cronRemove(id) when both lack the entry → returns false (0.284709ms)
  ✔ reconcileActiveTasks removes entries whose jobs are no longer in the registry (0.3025ms)
  ✔ reconcileActiveTasks skips silently when JSON parse fails (5.342375ms)
✔ Phase 4 — cronRemove fix + reconcile (6.400666ms)
[hivemind:queue] enqueued id=test-1 kind=request from=a (depth=1)
[hivemind:queue] enqueued id=test-0 kind=request from=a (depth=1)
[hivemind:queue] enqueued id=test-1 kind=request from=a (depth=1)
[hivemind:queue] enqueued id=test-2 kind=request from=a (depth=2)
[hivemind:queue] enqueued id=test-3 kind=request from=a (depth=3)
[hivemind:queue] enqueued id=test-4 kind=request from=a (depth=4)
▶ Hivemind inbound queue (v1.4.6)
  ✔ processes one inbound — start to end (7.915459ms)
[hivemind:queue] enqueued id=test-block kind=request from=a (depth=1)
  ✔ serializes 5 concurrent enqueues — all processed in order, none dropped (58.710084ms)
[hivemind:queue] enqueued id=test-throw kind=request from=a (depth=1)
[hivemind:queue] enqueued id=test-after kind=request from=a (depth=1)
[hivemind:queue] processor threw on id=test-throw: Error: boom
    at Object.process (/Users/glados/neato-hive/src/tools/messaging-queue.test.ts:92:36)
    at drainQueue (/Users/glados/neato-hive/src/tools/messaging.ts:591:20)
    at enqueueInbound (/Users/glados/neato-hive/src/tools/messaging.ts:578:8)
    at TestContext.<anonymous> (/Users/glados/neato-hive/src/tools/messaging-queue.test.ts:86:5)
    at Test.runInAsyncScope (node:async_hooks:226:14)
    at Test.run (node:internal/test_runner/test:1120:25)
    at async Suite.processPendingSubtests (node:internal/test_runner/test:789:7)
  ✔ isHivemindProcessing reflects worker state during processing (12.763917ms)
[hivemind:queue] enqueued id=stats-1 kind=response from=a (depth=1)
[hivemind:queue] enqueued id=stats-2 kind=request from=a (depth=1)
  ✔ processor exception does not stop subsequent inbounds (5.312083ms)
[hivemind:queue] enqueued id=block-0 kind=request from=a (depth=1)
[hivemind:queue] enqueued id=pile-1 kind=request from=a (depth=1)
[hivemind:queue] enqueued id=pile-2 kind=request from=a (depth=2)
[hivemind:queue] enqueued id=pile-3 kind=request from=a (depth=3)
[hivemind:queue] enqueued id=pile-4 kind=request from=a (depth=4)
[hivemind:queue] enqueued id=pile-5 kind=request from=a (depth=5)
[hivemind:queue] enqueued id=pile-6 kind=request from=a (depth=6)
[hivemind:queue] enqueued id=pile-7 kind=request from=a (depth=7)
[hivemind:queue] enqueued id=pile-8 kind=request from=a (depth=8)
[hivemind:queue] enqueued id=pile-9 kind=request from=a (depth=9)
[hivemind:queue] enqueued id=pile-10 kind=request from=a (depth=10)
[hivemind:queue] enqueued id=pile-11 kind=request from=a (depth=11)
[hivemind:queue] enqueued id=pile-12 kind=request from=a (depth=12)
[hivemind:queue] enqueued id=pile-13 kind=request from=a (depth=13)
[hivemind:queue] enqueued id=pile-14 kind=request from=a (depth=14)
[hivemind:queue] enqueued id=pile-15 kind=request from=a (depth=15)
  ✔ getInboundQueueStats reports depth + processing kind (13.069958ms)
[hivemind:queue] enqueued id=kind-test kind=escalation from=b (depth=1)
  ✔ backpressure warning fires at threshold (6.760833ms)
  ✔ queue is idle when nothing is enqueued (0.106458ms)
[hivemind:queue] enqueued id=kind-request-0 kind=request from=a (depth=1)
[hivemind:queue] enqueued id=kind-response-1 kind=response from=a (depth=1)
[hivemind:queue] enqueued id=kind-escalation-1 kind=escalation from=a (depth=2)
[hivemind:queue] enqueued id=kind-request-1 kind=request from=a (depth=3)
  ✔ getHivemindProcessingState reflects kind during processing (12.853458ms)
[hivemind:queue] enqueued id=reset-test kind=request from=a (depth=1)
  ✔ multiple kinds processed in FIFO order (22.701125ms)
[hivemind:queue] enqueued id=cycle-1 kind=request from=a (depth=1)
  ✔ _resetInboundQueueForTesting clears all state (6.718625ms)
[hivemind:queue] enqueued id=cycle-2 kind=request from=a (depth=1)
[hivemind:queue] enqueued id=age-test kind=request from=a (depth=1)
  ✔ enqueueInbound after drain completes starts a new drain cycle (12.10775ms)
  ✔ stats ageMs increases while processing (28.673208ms)
✔ Hivemind inbound queue (v1.4.6) (188.862792ms)
[hivemind:queue] enqueued id=state-test-req kind=request from=a (depth=1)
▶ parseHivemindMessage
  ✔ parses a legacy-format message (no marker) and tags it as legacy (0.703ms)
  ✔ parses a delegation marker (0.154458ms)
  ✔ parses a response marker (0.070375ms)
  ✔ parses an escalation marker (0.066875ms)
  ✔ parses a query marker (0.091041ms)
  ✔ treats an unknown kind as legacy (0.064375ms)
  ✔ returns null for non-hivemind content (0.060416ms)
  ✔ supports multi-line bodies (0.040833ms)
✔ parseHivemindMessage (1.752667ms)
▶ delegation registry
  ✔ registers a delegation with a unique taskId (0.196667ms)
  ✔ looks up a registered delegation by taskId (0.079708ms)
  ✔ returns undefined for unknown taskIds (0.060958ms)
  ✔ findActiveDelegationFor returns the most recent delegation to an executor (0.102375ms)
  ✔ prunes entries older than the TTL on read (0.05175ms)
  ✔ completeDelegation removes the entry (0.045666ms)
  ✔ newTaskId is unique per call (0.079125ms)
✔ delegation registry (0.71525ms)
▶ routeInbound
  ✔ ignores messages addressed to a different agent (0.099458ms)
  ✔ a delegation arrives as a request the receiver should process (0.040584ms)
  ✔ a query arrives as a request (0.039667ms)
  ✔ a legacy message arrives as a request (0.0365ms)
  ✔ a delegation followed by its response is routed correctly (0.049625ms)
  ✔ a response with no taskId is surfaced as stale, not silently dropped (0.054625ms)
  ✔ a response referencing an unknown taskId surfaces as stale (0.04175ms)
  ✔ a response whose endpoints don't match the registered delegation is stale (0.076708ms)
  ✔ an escalation routes as escalation regardless of registry presence (0.03525ms)
  ✔ an escalation surfaces the registry record when one exists (0.040917ms)
  ✔ escalation breaks out of #hivemind to the owner's channel (via routing record) (0.049375ms)
✔ routeInbound (0.650084ms)
▶ deriveSlug
  ✔ kebab-cases the first non-empty line (0.144666ms)
  ✔ strips punctuation and special chars (0.042208ms)
  ✔ collapses runs of whitespace and dashes (0.058625ms)
  ✔ caps at ~40 chars (0.034791ms)
  ✔ falls back to 'message' for empty / whitespace-only input (0.033042ms)
  ✔ skips leading blank lines (0.040833ms)
✔ deriveSlug (0.398958ms)
▶ maybeOffloadLargeMessage
  ✔ returns body unchanged when under the threshold (0.123416ms)
  ✔ offloads when body exceeds threshold and rewrites with [ATTACH:] (0.150875ms)
  ✔ the stub contains imperative instructions telling the receiver to use the Read tool (0.088459ms)
  ✔ disambiguates same-day repeats by appending a counter (0.063917ms)
  ✔ creates the exchange directory exactly once per offload (0.046667ms)
  ✔ keeps the stub small enough for the wire format to fit Discord's 4000-char limit (0.046167ms)
✔ maybeOffloadLargeMessage (0.572959ms)
▶ formatHeader
  ✔ emits a marker when taskId is present (0.043459ms)
  ✔ omits the marker when taskId is absent (legacy) (0.027708ms)
  ✔ round-trips through parseHivemindMessage (0.040042ms)
✔ formatHeader (0.137667ms)
▶ persistent delegation registry (autonomy-v1 finding a)
  ✔ setRegistryStateFile + getRegistryStateFile roundtrips (0.054583ms)
  ✔ registerDelegation appends a JSONL 'register' event when persistence is enabled (0.631916ms)
  ✔ completeDelegation appends a 'complete' event (0.377333ms)
  ✔ loadRegistryFromDisk replays active delegations into memory (0.372667ms)
  ✔ loadRegistryFromDisk omits delegations that completed before crash (0.369417ms)
  ✔ loadRegistryFromDisk drops entries older than the 24h TTL (0.344667ms)
  ✔ loadRegistryFromDisk skips malformed lines without poisoning the load (0.367125ms)
  ✔ loadRegistryFromDisk is a no-op when persistence is disabled (0.032833ms)
  ✔ DELEGATION_TTL_MS is 24h (autonomy-v1 finding a — bumped from 60min) (0.026083ms)
  ✔ the headline crash-recovery scenario: delegate → restart → response still routes (0.282583ms)
✔ persistent delegation registry (autonomy-v1 finding a) (2.947625ms)
▶ EscalateToOwner auto-reply suppression flag
  ✔ starts cleared (0.06ms)
  ✔ markEscalationFired sets the flag; consume reads-and-clears (0.038625ms)
  ✔ flag is independent of registry state (0.025708ms)
  ✔ _resetEscalationFlagForTesting clears the flag (0.026333ms)
  ✔ flag stays clear on partial-failure path (regression guard) (0.027042ms)
  ✔ the suppression flow models the intended bot behavior (0.027791ms)
✔ EscalateToOwner auto-reply suppression flag (0.253791ms)
▶ kind=response sender-side validation (v1.3.3 fix)
  ✔ routeInbound still rejects a response with no taskId (regression guard) (0.058792ms)
  ✔ routeInbound still rejects an unknown taskId (regression guard) (0.036708ms)
  ✔ the smoke-test scenario: responder sends kind=response with task_id from the DELEGATOR's registry (0.049917ms)
✔ kind=response sender-side validation (v1.3.3 fix) (0.171083ms)
▶ hivemind processing state (v1.4.6 — queue-based)
  ✔ isHivemindProcessing is false when idle (0.076ms)
[hivemind:queue] enqueued id=state-test-resp kind=response from=a (depth=1)
  ✔ isHivemindProcessing is true during queue processing (kind='request') (8.949709ms)
[hivemind:queue] enqueued id=state-test-esc kind=escalation from=a (depth=1)
  ✔ isHivemindProcessing is true during queue processing (kind='response') (6.262083ms)
[hivemind:queue] enqueued id=state-test-drain kind=request from=a (depth=1)
  ✔ isHivemindProcessing is true during queue processing (kind='escalation') (6.607542ms)
  ✔ state resets to idle after queue drains (6.163167ms)
✔ hivemind processing state (v1.4.6 — queue-based) (28.211792ms)
▶ writeHivemindReceipt (Phase 5 — observability)
  ✔ appends a JSON line to the receipt file (0.580833ms)
  ✔ multiple calls produce multiple lines (append, no rewrite) (1.644875ms)
✔ writeHivemindReceipt (Phase 5 — observability) (2.264458ms)
▶ sendToOwnChannel
  ✔ returns error when no primary channel registered (0.426583ms)
  ✔ returns error when Discord client is not initialized (0.08025ms)
  ✔ resolves the right channel from config (0.043667ms)
✔ sendToOwnChannel (0.930875ms)
ℹ tests 303
ℹ suites 68
ℹ pass 303
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 784.458625
==> Cleaning prior staging dir...
==> Staging REPLACE_LIST items into /Users/glados/neato-hive/dist-pkg/...
    + dist/
    + bin/
    + templates/
    + shared/
    + skills/
    + dashboard/
    + package.json
    + pnpm-lock.yaml
    + VERSION (generated)
==> Creating tarball /tmp/neato-hive-v1.4.9.tar.gz...
==> Computing SHA-256...
    SHA-256 = 7314ed4ac1fbed29c2206f1d6a6af46abf90b44d9d4ca31ba6ff56428d09221e

==> Release tarball ready:
    /tmp/neato-hive-v1.4.9.tar.gz
    /tmp/neato-hive-v1.4.9.checksums.txt

==> Tarball size: 2.0M
==> Inspect contents:  tar -tzf /tmp/neato-hive-v1.4.9.tar.gz | head -30
==> Audit:             bash scripts/release-audit.sh 1.4.9
==> B.2 will push to site repo + update current.json + index.json.
-rw-r--r--  1 glados  wheel       91 May  9 00:49 /tmp/neato-hive-v1.4.9.checksums.txt
-rw-r--r--  1 glados  wheel  2101754 May  9 00:49 /tmp/neato-hive-v1.4.9.tar.gz
```

### Step 3: fixture current.json
```
{
  "version": "1.4.9",
  "tarball_url": "file:///tmp/neato-hive-v1.4.9.tar.gz",
  "checksum_sha256": "7314ed4ac1fbed29c2206f1d6a6af46abf90b44d9d4ca31ba6ff56428d09221e",
  "released_at": "2026-05-09T07:49:03Z",
  "changelog_url": "file:///tmp/J1-fixture/changelog.html"
}
```

### Step 4: pre-install host snapshot
```
-rw-------  1 glados  staff  1466 May  8 11:03 /Users/glados/neato-hive/.env
```

### Step 5: install.sh fresh-install in sandbox
```
==> Neato Hive Installer (v1.5.0)

  ✓ macOS (darwin)
  ✓ Homebrew installed
  ✓ bash 3.2.57
  ✓ curl 8.7.1
  ✓ tar (bsdtar 3.5.3)
  ✓ node 25.7.0
  ✓ pnpm 10.30.3
  ✓ pm2 6.0.14
  ✓ openssl 3.3.6
==> Fetching release metadata from file:///tmp/J1-fixture/current.json
  Latest version: 1.4.9
  Tarball:        file:///tmp/neato-hive-v1.4.9.tar.gz
  Checksum:       7314ed4ac1fbed29c2206f1d6a6af46abf90b44d9d4ca31ba6ff56428d09221e

==> Downloading tarball
  ✓ Saved to /tmp/neato-hive-v1.4.9.tar.gz
  ✓ SHA-256 verified

==> Extracting to /tmp/J1-sandbox
  ✓ Extracted dist-pkg/ to staging
  ✓ Atomic-rename to /tmp/J1-sandbox
  ✓ Cleanup complete

==> Post-install setup
Lockfile is up to date, resolution step is skipped
Progress: resolved 1, reused 0, downloaded 0, added 0
Packages: +135
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Progress: resolved 135, reused 135, downloaded 0, added 135, done

dependencies:
+ @anthropic-ai/claude-agent-sdk 0.2.119
+ discord.js 14.26.3
+ dotenv 16.6.1
+ js-yaml 4.1.1
+ node-cron 3.0.3
+ zod 4.3.6

devDependencies:
+ @types/js-yaml 4.0.9
+ @types/node 22.19.17
+ @types/node-cron 3.0.11
+ tsx 4.21.0
+ typescript 5.9.3

╭ Warning ─────────────────────────────────────────────────────────────────────╮
│                                                                              │
│   Ignored build scripts: esbuild@0.27.7.                                     │
│   Run "pnpm approve-builds" to pick which dependencies should be allowed     │
│   to run scripts.                                                            │
│                                                                              │
╰──────────────────────────────────────────────────────────────────────────────╯
Done in 704ms using pnpm v10.30.3
  ✓ pnpm install --frozen-lockfile
  ✓ Generated dashboard token
  ✓ Wrote .env
  ✓ Mirrored token to /tmp/J1-mirror/dashboard-token

==> ✓ Install complete!

Next steps to start Hive:

  cd /tmp/J1-sandbox
  pm2 startOrReload ecosystem.config.cjs
  pm2 save

Then visit the dashboard at:

  http://localhost:7777/login.html

Your dashboard token (save it — you'll paste it on the login page):

  <REDACTED>

Token also saved at: /tmp/J1-mirror/dashboard-token

For setup beyond the dashboard (Discord bot, agents, Claude CLI):

  cd /tmp/J1-sandbox
  ./setup.sh --post-install

(setup.sh auto-detects the post-install state; --post-install is the explicit form.)

Spec / docs: https://github.com/anthonyconnelly/neato-hive
```

### Step 5 verification
```
sandbox dir contents:
total 120
drwxr-xr-x   13 glados  wheel    416 May  9 00:49 .
drwxrwxrwt  152 root    wheel   4864 May  9 00:49 ..
-rw-r--r--    1 glados  wheel     87 May  9 00:49 .env
-rw-r--r--    1 glados  wheel      5 May  9 00:49 VERSION
drwxr-xr-x    3 glados  wheel     96 May  7 15:16 bin
drwxr-xr-x   13 glados  wheel    416 May  8 15:53 dashboard
drwxr-xr-x   13 glados  wheel    416 May  8 21:38 dist
drwxr-xr-x   15 glados  wheel    480 May  9 00:49 node_modules
-rw-r--r--    1 glados  wheel    894 May  7 07:50 package.json
-rw-r--r--    1 glados  wheel  46144 May  6 12:48 pnpm-lock.yaml
drwxr-xr-x    8 glados  wheel    256 May  7 14:21 shared
drwxr-xr-x   12 glados  wheel    384 May  7 11:38 skills
drwxr-xr-x    6 glados  wheel    192 May  6 16:21 templates

.env content (token redacted):

HIVE_DASHBOARD_TOKEN=<REDACTED>

token mirror file mode:
-rw-------  1 glados  wheel  64 May  9 00:49 /tmp/J1-mirror/dashboard-token

token regex match: ^[a-f0-9]{64}$
MATCH ✓
```

### Step 6: dashboard process boot
```
Lockfile is up to date, resolution step is skipped
Already up to date

Done in 158ms using pnpm v10.30.3
PID=42696
dashboard process alive ✓

startup log:
[hive-dashboard] listening on 0.0.0.0:37990
```

### Step 7: dashboard endpoint smoke (token redacted in URL paths)
```
/api/health: {"version":"1.4.9","ok":null}
/api/status: {"ok":null}
/api/agents: {"count":0}
/api/doctor: {"has_summary":true}
/api/update/check: {"has_update_available":false}
query-param auth: {"ok":null}
```

### Step 8: hive update --check --json
```
{"update_available":false,"local_version":"1.4.9"}
```

### Step 9: setup.sh --post-install --help
```
bash: setup.sh: No such file or directory
```

### Step 10: setup.sh banner detection
```
env present
.setup-state absent (post_fresh_install state expected)
bash: setup.sh: No such file or directory
```

### Step 11: dashboard process teardown
```
dashboard PID 42696 stopped
```

### Step 12: post-test host snapshot diff
```
~/neato-hive/.env mtime BEFORE: 2026-05-08 11:03:15|1466|/Users/glados/neato-hive/.env
~/neato-hive/.env mtime AFTER:  2026-05-08 11:03:15|1466|/Users/glados/neato-hive/.env
DIFF: IDENTICAL ✓

~/.config/neato-hive/ BEFORE:
ABSENT
~/.config/neato-hive/ AFTER:
ABSENT
DIFF: IDENTICAL ✓ (both absent or same content)

~/.neato-hive/migrations/ BEFORE:
ABSENT
~/.neato-hive/migrations/ AFTER:
ABSENT
DIFF: IDENTICAL ✓
```

### Step 13: cleanup
```
cleanup complete
```

---

## Outcome summary

- **Install path:** PASS
- **Dashboard boot:** PASS
- **Endpoint smoke:** PASS (all 6 requests returned HTTP 200 with valid JSON)
- **`hive update --check --json`:** PASS
- **`setup.sh --post-install` flag + banner detection:** FAIL
- **Worker scope (host state preserved):** PASS

**Overall:** FAIL — see Step 9; installed package is missing `setup.sh`, so J.2 is BLOCKED until packaging includes the setup script.

---

## Anomalies

- Pre-flight command `bash scripts/install-prereqs.sh --json | jq -c .summary` returned `null`, but the raw JSON immediately below it reported `"all_satisfied":true` with all six prereqs satisfied.
- `install.sh` completed successfully and printed a post-install instruction to run `./setup.sh --post-install`, but the extracted sandbox tree did not include `setup.sh`; both Step 9 and Step 10 failed with `bash: setup.sh: No such file or directory`.
- The Step 7 jq projections for `/api/health` and `/api/status` surfaced `"ok":null`; the endpoints still returned HTTP 200 and valid JSON, but those payloads do not currently expose an `ok` field under this projection.

# Changelog

All notable changes to Neato Hive are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/) and the project
follows semantic versioning.

---

## [1.5.24] — 2026-05-12

**Long-standing overlay miss: `scripts/` was never overlaid on update.** Pre-existing installs never received `scripts/tailscale-expose.sh`, `scripts/install-prereqs.sh`, `scripts/smoke-test-bash3.sh`, or `scripts/release-*.sh` on `hive update` — the overlay's `REPLACE_LIST` was missing the `scripts` entry. v1.5.24 adds it. Without this fix, no doctor diagnostic helper, install-prereqs helper, or future framework script could ever land on an existing install.

### Fixed

- **`scripts/` directory is now part of the overlay `REPLACE_LIST`** in `bin/hive` `_update_apply_overlay`. Going forward, every `hive update` will overlay framework-managed scripts from the release tarball. Fix is a one-word addition to the REPLACE_LIST array.
- **Coworker-blocker resolved (real cause this time).** Dog's coworker's `hive doctor --fix-tailscale` failed because the verbose v1.5.23 helper was never actually installed — the `scripts/` directory was silently skipped by every prior update. After v1.5.24 update, `scripts/tailscale-expose.sh` will finally land in the install.

### Notes

- **Upgrade path:** `--repair` followed by `hive update` (standard recovery sequence). After v1.5.24 lands, the `scripts/` directory will be populated with the latest helpers. Re-run `hive doctor --fix-tailscale` and the verbose 5-phase output from v1.5.23 will finally be available.
- **Existing custom scripts in `scripts/` (if any) will be preserved across updates** via the v1.5.12 user-state merge logic in `_update_apply_overlay` — files in the install's `scripts/` directory that don't exist in the new tarball stay in place.

---

## [1.5.23] — 2026-05-12

**`hive doctor --fix-tailscale` now actually applies tailscale serve (verbose + force-reapply).** Previously the helper short-circuited on "already exposed" without verifying the dashboard was actually reachable, and silently exited on the failure path. v1.5.23 rewrites the helper to log every step explicitly, force-reapply when invoked via `--fix-tailscale`, and verify reachability after applying.

### Changed

- **`scripts/tailscale-expose.sh` is now step-by-step verbose.** Logs 5 phases explicitly: CLI availability, backend state, current serve config inspection, optional reset, apply + verify. Users running the helper directly (or via doctor) can immediately see which step failed.
- **New `FORCE_REAPPLY=1` env var.** Resets any existing serve config before re-applying. Default mode (no env var) remains idempotent — skips the serve call if already configured for our target. Used by `hive doctor --fix-tailscale` so the doctor fix mode aggressively re-applies even on stale or stuck configs.
- **Captures and surfaces stderr from `tailscale serve`.** Previously stderr was suppressed via `>/dev/null`, so any error from the actual serve command was invisible. v1.5.23 captures the output and prints it indented under the step header.
- **Reachability check post-apply.** After `tailscale serve` returns 0, the helper curls the resulting HTTPS URL (10s timeout) and reports HTTP status. Warns clearly if the URL returns non-200 — common cause is HTTPS cert provisioning still in progress, second most common is the dashboard daemon not running on localhost:7777.
- **`bin/hive` `_doctor_check_tailscale_expose`** invokes the helper with `FORCE_REAPPLY=1` when `--fix-tailscale` is set, and reports FAIL (not just WARN) if the helper emits `FAILED to apply tailscale serve`.

### Notes

- **No code path removed.** Idempotent default behavior is preserved for installs that already have the correct serve config. The FORCE_REAPPLY toggle is opt-in for the explicit-fix path.
- **Common cert-provisioning gotcha documented in the helper output:** if `tailscale serve --bg --https=443` returns success but the HTTPS URL doesn't respond, the tailnet's MagicDNS/HTTPS-certs setting in the admin console is the usual culprit. The reachability-check WARN line surfaces this explicitly.
- **Upgrade path:** `hive update` to v1.5.23, then `hive doctor --fix-tailscale`. The verbose output will diagnose any remaining issue.

---

## [1.5.22] — 2026-05-12

**`hive doctor` no longer false-positives "behind by N commits" on tarball-overlay installs.** Pre-v1.5.8 clone-style installs left a git remote behind. `hive update` overlays release tarballs and doesn't touch git refs, so any clone-installed hive accumulated misleading "behind by N commit(s)" warnings even after updating to the latest published version. v1.5.22 drops the git check entirely and uses the release manifest as the single source of truth.

### Changed

- **`hive doctor` "Up to date" check is now release-manifest only.** Previously: try `git fetch origin main && git rev-list HEAD..origin/main`, fall back to `current.json` API only if git unavailable. Now: compare local `package.json` version against the website's published `current.json` version. Semver-aware (uses the v1.5.18 `_update_compare_versions` helper) — only WARNs when `local < remote`, treats `local == remote` and `local >= remote` (release-ceremony state) as OK. Offline detection unchanged.
- **Coworker-impact resolved.** Trigger context: dog's doctor was reporting "behind by 31 commit(s) — run 'hive update'" after successfully updating to v1.5.20 + v1.5.21, because his install had a git remote from an older clone and the git state had drifted from the release tarball history. With v1.5.22, doctor reports `OK (vX.Y.Z matches website)`.

### Notes

- **No code path removed for installs that DON'T have a git remote** — they were already taking the API-fallback path. v1.5.22 just removes the legacy git-first branch.
- **Upgrade path:** `hive update`. After update, run `hive doctor` to confirm the "Up to date" line reads `OK (vX.Y.Z matches website)` instead of the spurious git-behind warning.

---

## [1.5.21] — 2026-05-12

**PM2 args auto-migration on update + full-directory `--repair` backups.** A coworker's v1.5.15 → v1.5.20 update restarted agents with PM2's stale positional-arg registrations, so the current CLI saw no `--agent` flag, printed usage, exited, and crash-looped until each agent was manually deleted and re-registered. This release auto-reconciles those PM2 registrations during `hive update` and hardens `install.sh --repair` by preserving the whole `bin/` directory instead of just `bin/hive`.

### Added

- **Automatic PM2 args reconciliation during `hive update` finalize.** New `_update_reconcile_pm2_agent_args` inspects `pm2 jlist`, detects hive agents still registered with the legacy positional-arg shape, snapshots the raw pre-migration PM2 state to `~/.neato-hive/pm2-migration-<UTC-timestamp>.json`, re-registers each stale agent with `-- --agent <name>`, and defers `pm2 save` to the existing later restart/save phase so `pm2 resurrect` can recover the original dump if re-registration fails.

### Changed

- **`install.sh --repair` now backs up the entire `bin/` directory.** The repair flow now duplicates `bin/` to `bin.repair-backup-<UTC-timestamp>/` before swapping in the refreshed `bin/hive`, uses that directory for rollback if the copy or chmod step fails, and auto-prunes older `bin.repair-backup-*` directories so only the 5 most recent remain.

### Notes

- **Coworker-blocker resolved.** Trigger context: dog's v1.5.15 → v1.5.20 update restarted PM2 processes with their stored legacy argv, so agents immediately exited on startup because the current `src/index.ts` requires the canonical `--agent` flag form.
- **Recovery path if PM2 migration fails mid-update:** the framework overlay remains applied, `pm2 save` is intentionally skipped, and the operator can use `pm2 resurrect`, `hive start <agent>`, and the `pm2-migration-<UTC-timestamp>.json` audit snapshot to recover daemon registrations manually.

---

## [1.5.20] — 2026-05-12

**Update finalize no longer reverts a clean overlay on doctor WARNs.** A coworker's v1.5.15 → v1.5.19 update hit the new v1.5.18 doctor sweep, surfaced one errored process plus three expected-during-update WARNs, and reverted after the PRESERVE_LIST byte-identical verify had already passed. v1.5.20 fixes the two stacked sensitivity bugs in that finalize flow.

### Fixed

- **Bug A — finalize-time ordering now restarts PM2 before doctor runs.** In v1.5.18, `_update_post_overlay_finalize` ran `cmd_doctor --fix --yes` before the later `[pm2-restart]` phase in `_update_run_full_flow_with_revert`. That made the new `framework-version-drift` doctor check WARN by construction on every successful update, because the daemons had not yet been fully restarted into the new code. Fix: move the full `pm2 restart all --update-env && pm2 save` step into finalize immediately after PRESERVE_LIST verify and before doctor.
- **Bug B — finalize-time doctor sweep is now informational, not fatal.** `cmd_doctor --fix --yes` exits non-zero whenever it finds issues, even when those issues are WARN-class or unrelated to overlay correctness (tailscale expose, plist persistence, pre-existing agent health). `_update_doctor_sweep` now always returns success, prints the doctor's tail output, and tells the user to run `hive doctor --fix` after the update if follow-up work remains. The actual hard integrity gate remains `_update_preserve_list_hash_verify`.

### Notes

- **Coworker-blocker resolved.** Trigger context: dog's v1.5.15 → v1.5.19 update reverted after doctor surfaced four expected-during-update findings despite a clean overlay and successful PRESERVE_LIST byte-identical verify.
- **Upgrade path:** normal `hive update` from inside `~/neato-hive`. The temporary `HIVE_UPDATE_SKIP_DOCTOR=1` workaround that unblocked users between v1.5.18 and v1.5.20 is no longer necessary, though the flag is still honored.

---

## [1.5.19] — 2026-05-12

**`install.sh --repair` — bootstrap-class recovery without re-installing.** When a `hive update` flow itself is broken (PRESERVE_LIST drift false-positives, finalize failures, version-compare bugs, anything that lives in `bin/hive`), users were stuck: the broken `bin/hive` runs `hive update`, and the fix lives in a newer release the broken `bin/hive` can't install. v1.5.19 adds a single curl-bash recovery path that breaks the loop.

### Added

- **`install.sh --repair` flag.** New mutex-gated mode that refreshes only `bin/hive` from the latest published release without touching anything else. Standard recovery pattern, regardless of which version is broken or which version fixes it:
  ```bash
  curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash -s -- --repair
  hive update
  ```
  The repair flow fetches the current release manifest from `releases/current.json`, downloads the tarball, verifies its SHA-256 checksum, extracts only `bin/hive` (supports both `bin/hive` and legacy `dist-pkg/bin/hive` tarball layouts), backs up the existing binary as `bin/hive.repair-backup-<UTC-timestamp>`, swaps in the new one, and chmods it executable. On any failure path (download, checksum, extract, swap, chmod), the existing `bin/hive` is restored from backup and the script exits non-zero with a specific error. Honors `--target-dir`, `--api-url`, `--skip-checksum`, `--yes`; mutually exclusive with `--check-only`, `--no-install-prereqs`, `--interactive-prereqs`, `--migrate`, `--fresh`.
- **Mode-mutex retrofit on `--migrate` and `--fresh`.** Required for `--repair` mutex to actually work — previously those flags didn't register in `mode_seen`. Side effect: `install.sh --migrate --fresh` now errors with "mutually exclusive" instead of silently combining (which previously had undefined behavior).
- **`compute_sha256()` helper in `install.sh`.** Extracted from `verify_checksum` so it works pre-OS-detection (the repair flow runs before `detect_os`). Detects `shasum` (macOS) or `sha256sum` (Linux) via `command -v` instead of branching on `$OS_NAME`. No functional change for normal install flows.
- **README "Recovery" section.** Documents the curl-bash repair pattern between "Getting help" and "License" sections.

### Notes

- **What's preserved during `--repair`:** all agent state under `agents/<name>/*` (memory, sessions, delegation registries), all workspace files (`.env`, `dashboard/data/`, `config/users.local.yaml`), PM2 daemons keep running (`--repair` does not restart anything).
- **What's swapped:** only `bin/hive`.
- **Upgrade path:** `hive update` from inside `~/neato-hive`. The `--repair` flag itself only becomes available after this release is published — users stuck on older versions still benefit from the v1.5.18 PRESERVE_LIST fix via normal update, and can use `--repair` going forward for any future bootstrap-class bug.
- **Use cases:** the immediate trigger was the coworker-rollout fire on v1.5.15 → v1.5.17 where `data/runner-events.log` drift blocked the update. v1.5.18 fixed that specific bug. v1.5.19 ships the generic safety net for the next "broken version can't update past itself" class bug, whatever it turns out to be.

---

## [1.5.18] — 2026-05-12

**Update-flow hardening: `hive update` now restarts daemons, drift detection ignores live log files, version compare is semver-aware, doctor catches stale-code fleet drift, and release ceremony auto-regenerates the public changelog.** This release closes a class of update-flow bugs surfaced by coworker rollouts of v1.5.17. Five related fixes, all touching the same `hive update` lifecycle.

### Fixed

- **PRESERVE_LIST drift false-positive on `data/` runtime files** (`bin/hive` `_update_preserve_list_hash_capture`). Previously, `hive update` walked `data/` and hashed every file at baseline + verify. Because `hive-runner` and `agent-watcher` daemons continued writing to `data/runner-events.log` and `data/agent-watcher.log` during the update window, the verify hash differed from baseline → drift detected → revert. The overlay never wrote to `data/`; the daemons did. Fix: drop `data/` from the drift-detection walk. The overlay's hash discipline still covers `agents/` (user state), `~/.neato-hive/skills/`, and the explicit `.env`/`config/*.local.yaml` allowlist.
- **Version comparison no longer suggests downgrades** (`bin/hive` `_update_compare_versions`). The old check was `local != remote → update available` — which flagged "update available" with a backward arrow whenever local was AHEAD of remote (e.g. during a release ceremony where local main is bumped before Vercel auto-deploys current.json). Replaced with proper semver compare: major.minor.patch parsed numerically, "update available" returns true only when local < remote.

### Added

- **`hive update` now restarts all PM2 daemons before declaring complete.** New `[pm2-restart]` phase between the v1.5.0 first-run migration and the "[full-flow] complete" message. Runs `pm2 restart all --update-env && pm2 save`. Without this, daemons kept executing pre-update code until they happened to be recycled by unrelated triggers — meaning half the fleet would pick up new code automatically and the other half (low-recycle daemons like `hive-runner`, `hive-dashboard`, low-traffic agents) stayed on stale code indefinitely. The SSE `done` envelope now includes a `restart_status` field (`completed` / `skipped` / `failed`). Honors `HIVE_UPDATE_SKIP_RESTART=1` for CI/scripted use.
- **`hive doctor` now checks framework version drift.** New `_doctor_check_framework_version_drift` check compares each PM2 process's `pm_uptime` start timestamp against `package.json`'s mtime. WARNs and lists any daemons that started before the current version file was last modified — i.e. daemons running pre-update code. Fix suggestion in the doctor output: `pm2 restart all --update-env && pm2 save`. Safety net for cases where someone forgot `--update-env` or where `hive update`'s restart phase was skipped.
- **`release-publish.sh` auto-regenerates `public/changelog.html`** on every release. Previously, the website's changelog page was the v1.5.0 placeholder ("Release notes coming at J.2.") because the publish script never touched it — every release since v1.5.0 had stale public-facing release notes. Fix: pandoc-based regeneration step, preserves the existing template wrapper (header, wordmark, nav) and replaces only the `<main>...</main>` body with the freshly rendered CHANGELOG.md content.

### Notes

- **Coworker-blocker resolved.** Multiple coworker `hive update` attempts on v1.5.15 → v1.5.17 were failing with `ERROR: PRESERVE_LIST drift detected — overlay touched protected files` pointing at `data/runner-events.log`. v1.5.18 unblocks them.
- **Upgrade path:** `hive update` from inside `~/neato-hive`. After this release, daemon-restart happens automatically as part of the update — no need to manually `pm2 restart all` afterward.
- **Stale-fleet awareness:** if you've been running v1.5.15-v1.5.17 with manual `pm2 restart` discipline, `hive doctor` will now confirm green for "Framework version drift" once you've updated to v1.5.18 and daemons have restarted. If it WARNs, follow the inline fix suggestion.

---

## [1.5.17] — 2026-05-12

**Hotfix: dashboard chat → Discord mirror restored.** Reverts the silent default-off behavior introduced by PR #90 (OPERATIONAL-1) in v1.5.16. Single-Hive installs once again get a working bidirectional chat mirror by default, with no `.env` edits required.

### Fixed

- **`src/local-bridge/index.ts` no longer hard-exits when `LOCAL_BRIDGE_URL` is unset (PR #99).** The bridge enablement gate moved from the module's internal env-check to the caller (`src/discord/bot.ts`). Local-bridge now gates only on its `hubUrl` parameter — empty string disables, non-empty connects. The env-based disable mechanism is replaced by a new explicit `LOCAL_BRIDGE_DISABLED=true` opt-out flag (documented in `.env.example`). This restores the v1.5.15-era default-on behavior every single-Hive install relied on for dashboard chat to mirror to Discord channels.

### Added

- **`computeBridgeHubUrl(env, agentName)` helper in `src/discord/bot.ts` (PR #99).** Precedence: `LOCAL_BRIDGE_DISABLED=true` → empty (disable), else non-empty `LOCAL_BRIDGE_URL` → use that, else default `ws://127.0.0.1:7777/ws/agent/<agentName>`. Unit-tested in `bot.test.ts` for all three paths.
- **`.env.example` documents the trio:** default-loopback (unset/empty `LOCAL_BRIDGE_URL`), URL override (non-empty `LOCAL_BRIDGE_URL` for remote/multi-Hive), explicit opt-out (`LOCAL_BRIDGE_DISABLED=true`).

### Notes

- **Symptom in v1.5.16:** dashboard chat UI accepted messages but they never reached the target agent. Browser sent `{kind:'send'}` to dashboard WS; dashboard's `agentSockets.get(agentName)` returned undefined (no agent had connected to `/ws/agent/<name>`); dashboard returned `{type:'error', code:'agent_offline'}` which the chat UI silently dropped (frame had no `channel` field). Symptom went live at the 21:42Z daemon restart for v1.5.16 — pre-restart daemons were on pre-PR-#90 code that did not have the regression.
- **Upgrade path:** run `hive update` from inside `~/neato-hive`, then `pm2 restart all`. No `.env` edits required for the default single-Hive install. Anyone previously relying on "leave `LOCAL_BRIDGE_URL` blank to disable" must migrate to `LOCAL_BRIDGE_DISABLED=true`.
- **Sidecar bug deferred to a future hygiene leaf:** the chat UI silently drops `{type:'error'}` frames because they lack a `channel` field. Even after this fix, legitimate agent-offline conditions (agent crashed, restarting) show no UI feedback. Will be addressed in a follow-up release.

---

## [1.5.16] — 2026-05-12

**Dashboard is now reachable from any tailnet device via auto-detected Tailscale Serve, with bind tightened to localhost and auth opt-in.** This release bundles ten merged PRs that close out a coworker-rollout-readiness pass: tailscale integration for remote dashboard access, install.sh + setup.sh + hive update + hive doctor hardening, and release-ceremony improvements that eliminate the manual `public/` sync step from previous cycles.

### Added

- **Tailscale Serve auto-expose for the dashboard (PR #98).** When `tailscale` is installed and logged in, the install wizard prompts (default No, explicit `y` to opt in) and runs `tailscale serve --bg --https=443 http://localhost:7777`. Coworkers reach the dashboard at `https://<host>.<tailnet>.ts.net/` from any of their tailnet devices — no port-forwarding, no manual one-liner. Helper at `scripts/tailscale-expose.sh` is idempotent (re-runs report "already exposed") and handles port-conflict states without overwriting.
- **`hive doctor --fix-tailscale` flag (PR #98).** Doctor's tailscale check is now read-only by default (surfaces state: exposed / not exposed / tailscale absent / not running). `--fix-tailscale` is the explicit opt-in path to enable exposure after install — for users who said No during the wizard or ran `tailscale serve off` and want to re-enable.
- **`DASHBOARD_REQUIRE_AUTH` env var (PR #98).** Default `false`: dashboard reachable on localhost and via Tailscale Serve with no login UX friction. Set `true` to gate every route on the saved token (current behavior, preserved for shared-machine deployments). HTTP middleware, WebSocket auth, and frontend token logic all conditional on the new `/api/auth-config` bridge.
- **Bash 3.2 smoke test gate in `scripts/release-audit.sh` (PR #96, F-13).** New `scripts/smoke-test-bash3.sh` extracts the just-built tarball into a sandbox, runs `hive update --check` and `hive update --dry-run` under stock macOS bash 3.2, and asserts no overlay shadow files or staging residue are produced. Release ceremony now fails fast if a bash-3.2 regression sneaks into a future release (prevents the v1.5.10 unbound-variable class).
- **Runtime prereq auto-install during curl-bash install (PR #97, F-14).** `install.sh` now auto-installs `flock`/`gh`/`jq`/`tmux`/`ffmpeg`/`pandoc`/`sqlite3` via brew (macOS) or apt-get (Linux) as a non-fatal post-pnpm step, matching `hive update`'s `_update_install_runtime_prereqs` behavior. `setup.sh` step 2's APT_TOOLS list restructured to `binary:package` mapping so `flock:util-linux` resolves correctly. Existing installs see "already installed" microcopy instead of re-running brew.
- **Doctor validates paired OPTIONAL env keys (PR #93, F-12).** New section-aware `.env` validator catches mismatched `OP_VAULT_NAME` / `OP_SERVICE_ACCOUNT_TOKEN` and `DASHBOARD_BRIDGE_*` pair states and surfaces them as INFO (not WARN — these are optional integrations).

### Changed

- **Dashboard binds `127.0.0.1` instead of `0.0.0.0` (PR #98).** Implicit-broken before — any device on the same LAN could reach the dashboard. Now LAN-adjacent devices cannot; only same-machine localhost callers and Tailscale Serve proxied tailnet requests get through. Set `HIVE_DASHBOARD_HOST=0.0.0.0` to restore prior behavior (not recommended).
- **`hive update --dry-run` now exercises download + checksum + extract (PR #96, F-13).** Previously exited after metadata compare only. Required for the bash 3.2 smoke test to be meaningful: the regression class lived downstream of compare. `hive update --check` remains the cheap metadata-only path.
- **`release-publish.sh` writes to `public/` directly (PR #94, F-1).** Eliminates the manual `cp -R releases/v<v> public/releases/v<v>` + `current.json` / `install.sh` / `index.json` sync that was required on every release ceremony since v1.5.0. Closes the F-1 follow-up that has been open since v1.5.0 J.2.
- **`setup.sh` step 9 split into 9a (install/build/link) and 9b (start/verify) (PR #95, F-6).** Surfaces fresh-install failures sooner — if the build fails in 9a, step 9b never runs, and the failure is on the operator's screen instead of buried behind a started-but-broken PM2 daemon.
- **`setup.sh` skips rebuild when `dist/` is already fresh (PR #92, F-8).** File-mtime check: if `dist/index.js` is newer than `pnpm-lock.yaml`, the build step short-circuits. Speeds up `hive update` no-op re-runs and re-bootstraps on already-built clones.
- **`install.sh` drops redundant pnpm prereq install (PR #91, F-7).** Was attempting to install pnpm via npm before corepack pinning. Removed; corepack pins pnpm from `package.json#packageManager` at build time, no second install needed.

### Fixed

- **`local-bridge` graceful no-hub short-circuit (PR #90, OPERATIONAL-1).** When the dashboard daemon is not running, `bridgeStartedAt` was throwing instead of returning a friendly "not started" state. UX shift: cleaner error in agent logs, no functional impact on bots.
- **`src/discord/bot.ts` clientReady event rename for discord.js forward-compat (PR #89, F-9).** Belt-and-suspenders pattern: listens to both `ready` (v14) and `clientReady` (v15) events so the bot survives a discord.js major-version bump without code change.

### Notes

- **Coworker rollout-readiness.** This release is the version-bump cut to ship the tailnet-reachable dashboard to coworker hives. Run `hive update` from inside `~/neato-hive`, or for legacy v1.4.x installs, re-run the curl-bash installer to absorb-mode-migrate to v1.5.16. The dashboard URL after install is either the tailnet `https://...ts.net/` URL (if the user opted in during the wizard) or `http://localhost:7777` (default fallback).
- **CHANGELOG drift acknowledgement.** v1.5.13–v1.5.15 entries below this entry are out of strict chronological order (the file's top entry — v1.5.12 — was inserted late as a backport-style note for notLmax's PR #87 contribution). Drift is not corrected in this release; will be cleaned in a future hygiene pass.

---

## [1.5.12] — 2026-05-11

**Discord typing indicator no longer leaks past message delivery on attachment-heavy replies.** When an agent sent a reply containing multi-MB file attachments, the typing indicator stayed visible on the user's side for tens of seconds after the message landed. Root cause: `clearInterval(typingInterval)` was being called BEFORE the `await sendToChannel(...)` that uploaded the attachments. The interval stopped pinging, but the last `sendTyping()` ping was still within Discord's ~10s server-side typing window; with a 6+ MB upload spanning several seconds, the indicator survived past the awaited send. A duplicate `clearInterval` in each handler's `catch` block masked the lack of a single guaranteed cleanup site. (Contributed by notLmax — PR #87.)

### Fixed

- **`clearInterval(typingInterval)` now fires in a `finally` clause in both Discord bot handlers** (`src/discord/bot.ts`, hivemind-receive at ~L775 and user-message at ~L1053). The early `clearInterval` before the awaited sends is removed, the duplicate inside `catch` is removed, and a single `finally`-block `clearInterval` guarantees cleanup AFTER all awaited sends complete (success or error). The hivemind handler already had a `finally` block (for `writeHivemindReceipt`); the `clearInterval` was added at its top. The user-message handler had no `finally` previously; a new one was added with `clearInterval` as its only statement.

### Notes

- Follow-up to v1.4.x `b73fc1c` (`fix(bot): harden Discord REST + crash-detect against outage hangs`), which made `sendTyping()` calls fire-and-forget but did not collapse the interval-cleanup sites.
- Net effect: typing indicator now stops the moment the bot is genuinely done sending. No change to attachment-upload behavior or message content.
- Diff is 1 path, +3/-6 LOC. 303 existing tests still pass; no regression introduced.

---

## [Unreleased]

(empty — accumulated fix ships below as v1.5.14)

---

## [1.5.15] — 2026-05-12

**Legacy migration is now `curl ... | bash`.** Replaces the multi-step playbook approach with snapshot-and-absorb baked into `install.sh`. Modern hives (v1.5.0+) continue to use `hive update` for routine updates; legacy hives (v1.4.x or earlier) auto-detect on install.sh and run the absorb flow.

### Added

- **`install.sh` version-aware classification + branched flow.** Reads the existing `~/neato-hive/package.json` version on startup and classifies as `fresh`, `modern`, or `legacy`. Behavior per branch:
  - **fresh** → standard fresh install (unchanged).
  - **modern** → refuses re-install with a message pointing to `hive update`. Exit 0.
  - **legacy** → triggers absorb mode automatically (7 steps: stop PM2 → snapshot → move-aside → fresh-install → absorb state → re-register PM2 → run `hive doctor`).
- **`install.sh --migrate` flag** — forces absorb mode even on modern installs. For recovery, corruption fixes, accumulated-drift cleanups.
- **`install.sh --fresh` flag** — moves existing install to `~/neato-hive.wiped-<ts>/` and starts clean. Destructive; no absorb.
- **Snapshot insurance.** `~/neato-hive.backup-<ts>/` is a full filesystem copy of the existing install BEFORE any destructive op. Old install also preserved at `~/neato-hive.old-<ts>/`. Both stay until user manually deletes them.
- **Explicit absorbed paths:** `.env`, `.env.local`, `config/agents.local.yaml`, `config/users.local.yaml`, `config/config.yaml.backup-*`, every `agents/<name>/` directory with an `IDENTITY.md`, and `data/`. Framework files (`config/config.yaml`, `dist/`, `bin/`, `setup.sh`, etc.) come from the fresh tarball — no drift, no overlay edge cases.

### Removed

- **`docs/legacy-migration-playbook.md`** — superseded by `install.sh`'s auto-detect absorb mode. Migration is now a single command (`curl -fsSL ... | bash`); no Discord-channel playbook paste needed.
- **`docs/legacy-git-clone-test-migration.md`** — same. The 13-step defensive playbook is now baked into install.sh as actual code rather than instructions for an agent to follow.

### Notes

- Snapshot + old-install dirs remain on disk after migration. Owner deletes when comfortable with the new install. Typical disk overhead ~50–500MB temporarily.
- PM2 brief downtime during absorb (steps 1–6 take ~30 seconds total). Discord bots reconnect automatically. In-flight codex workers are killed; if a coworker has active autonomous work, wait until it completes before running the migration.
- `hive update` is unchanged — it remains the daily-driver fast-path for v1.5.X → v1.5.Y bumps. The PRESERVE_LIST and overlay logic (v1.5.12, v1.5.14 fixes) still apply for modern-to-modern transitions. Absorb-mode is the heavy hammer for legacy or recovery.

---

## [1.5.14] — 2026-05-12

**PRESERVE_LIST baseline no longer flags legitimate framework updates as drift.** Fast-track ship — every coworker with locally-modified or older `config.yaml` content was hitting "PRESERVE_LIST drift detected" on `hive update` and reverting. Now `hive update` handles the transparent overwrite of framework files inside `config/` without manual stash workarounds.

### Fixed

- **PRESERVE_LIST baseline excludes framework-tracked files in `config/`.** Coworker (jasonisaac) hit drift on `config/config.yaml` itself. The framework's `config/config.yaml` IS supposed to be replaced by the overlay — but v1.5.13's baseline walked the entire `config/` directory and hashed every file, so when the overlay legitimately updated `config.yaml`, the verify step saw a hash mismatch and reverted. v1.5.12's user-state-merge fix prevented user files from being LOST during overlay, but didn't address PRESERVE_LIST being over-inclusive about which files mattered. Fix: remove `config/` from the blanket find-walk in `_update_preserve_list_hash_capture` and rely exclusively on the explicit allowlist (`config/agents.local.yaml`, `config/users.local.yaml`, `config/config.yaml.backup-*`). `agents/`, `data/`, `~/.neato-hive/skills/` continue to walk-and-hash everything because those are all-user-state directories.

### Notes

- This is the third PRESERVE_LIST related fix (v1.5.12 fixed user-files-getting-wiped; v1.5.14 fixes framework-files-flagged-as-protected). The baseline logic is now correctly scoped to user state ONLY.
- End-user impact: every coworker on v1.5.13 or earlier who runs `hive update` will hit this once during the upgrade to v1.5.14. Same stash-workaround as before (`mv config/config.yaml /tmp/...`, update, restore). After landing on v1.5.14, future updates work without manual intervention.

---

## [1.5.13] — 2026-05-11

---

## [1.5.13] — 2026-05-11

**`hive update` now auto-reconciles PM2 daemons; `hive doctor` actively checks `hive-dashboard`.** Closes the parity gap surfaced during a legacy v1.4.7.1 test migration where `hive update` overlayed `ecosystem.config.cjs` but never started the new `hive-dashboard` daemon it declared. Also bundles two migration playbooks Daniel uses to roll out legacy → modern transitions to coworker hives.

### Fixed

- **`hive update` now reconciles PM2 daemons against the new `ecosystem.config.cjs` automatically.** Legacy installs that gained `ecosystem.config.cjs` via the v1.5.0 cutover but never ran the `pm2 startOrReload` step ended up with the new file on disk but `hive-dashboard` never started — `setup.sh` step 9 only fires on fresh installs, not on `hive update`. New `_update_reconcile_pm2_daemons` step runs after `_update_install_runtime_prereqs` in `_update_post_overlay_finalize`. Non-fatal — failure logs WARN, does not revert the overlay.
- **`hive doctor` now actively checks that `hive-dashboard` daemon is online** alongside the existing `Runner (hive-runner)` check. Mirrors the runner check pattern: WARN with `hive bootstrap` recovery hint if missing; auto-restart logic when `--fix` is invoked.

### Added

- **`docs/legacy-migration-playbook.md`** — 7-step playbook Daniel pastes into a coworker's `#house-md` channel for active fleet migration (v1.5.0–v1.5.11 → current modern updater state).
- **`docs/legacy-git-clone-test-migration.md`** — 13-step defensive playbook for testing the legacy → modern transition on a low-stakes pre-v1.5.0 git-clone install. Includes snapshot insurance, rollback protocol, and 13+ failure-mode recovery hints.

### Notes

- These fixes close the "legacy hive updated, dashboard silently not online" gap. Future legacy migrations don't need the playbook STEP 5 (`hive bootstrap`) as a separate manual step — `hive update` itself reconciles daemons.

---

## [1.5.12] — 2026-05-11

---

## [1.5.12] — 2026-05-11

**`hive update` overlay now preserves user-state files inside directories it replaces.** Fast-track ship — a coworker's `hive update` from v1.5.10 → v1.5.11 hit `PRESERVE_LIST drift detected — overlay touched protected files` and the update reverted. The bug blocks every coworker with gitignored config from updating.

### Fixed

- **`_update_apply_overlay` merges user-state forward before each directory swap.** Root cause: the overlay does whole-directory swap (`mv config shadow; mv tarball-config config`). The tarball's `config/` only contains tracked files (per v1.5.2's gitignore-respecting staging fix). The user's gitignored files (`config/agents.local.yaml`, `config/users.local.yaml`, `config/config.yaml.backup-*`, `shared/exchange/*`, etc.) got moved into the shadow directory along with the tracked content, leaving the new `config/` without them. PRESERVE_LIST verify ran after the swap and saw the user-state files missing → drift → revert. User data was safe (the revert restored it from the shadow) but the update could never complete. Fix: before each directory swap, copy every file in `dst` that is NOT in `src` (user-added gitignored files) into the staging area, so the swap brings BOTH the tarball's tracked files AND the user's state forward. Applied universally to every REPLACE_LIST directory.

### Notes

- Existing installs running `hive update` from v1.5.10 or v1.5.11 will hit the bug ONE MORE TIME (their existing `bin/hive` has the buggy overlay). Workaround: stash user-state files temporarily, run `hive update`, restore them — see release notes / `#hive-help`. After they land on v1.5.12, future updates handle this automatically.

---

## [1.5.11] — 2026-05-11

---

## [1.5.11] — 2026-05-11

**`hive update` now auto-installs runtime prereqs the new framework requires.** A coworker upgrading from a legacy v1.4.x install hit `flock: command not found` after `hive update` overlayed the v1.5.x framework. Root cause: `flock` (Linux file-locking utility, brew formula on macOS) was added as a runtime dependency between v1.4.x and v1.5.x. `setup.sh` step 2 installs it on fresh installs, but `hive update` never ran step 2 — it just overlayed framework files. Legacy installs ended up with the new framework but missing the system binaries it relied on. v1.5.11 closes that gap.

### Fixed

- **`hive update` runs a runtime-prereq check after every overlay.** New helper `_update_install_runtime_prereqs` runs after `pnpm install` completes (per-leaf within `_update_post_overlay_finalize`). It checks for `flock`, `gh`, `jq`, `tmux`, `ffmpeg`, `pandoc`, `sqlite3` — every system binary the framework calls at runtime. Missing ones are installed via Homebrew (macOS) or `apt-get` (Linux, with `util-linux` for flock). The step is non-fatal: a failed prereq install logs WARN but does NOT revert the overlay, because the framework files themselves are still valid — the user just needs to install the missing binary manually and re-run `hive doctor` to verify.
- **`hive doctor` now reports each runtime prereq individually.** A new block in the `deps` section lists `flock installed`, `gh installed`, `jq installed`, `tmux installed`, `pandoc installed`, `sqlite3 installed`. Each prints OK or WARN with a per-OS install hint (`brew install <pkg>` on macOS, `sudo apt-get install <pkg>` on Linux). End-user impact: post-update users running `hive doctor` see exactly which binaries are missing without needing to grep `pm2 logs` for `command not found`.

### Notes

- The new logic is OS-aware: macOS uses Homebrew (with a guard to print the Homebrew install command if `brew` itself is missing); Linux uses `apt-get` with `util-linux` mapping for `flock`. Other OSes log a WARN and skip auto-install.
- Sudo prompts on Linux are surfaced clearly — the helper attempts `sudo -n true` first to detect cached credentials and prints a "sudo password may be required" line if it isn't.
- F-14 (new follow-up): add the same runtime-prereqs check to `install.sh`'s curl-bash bootstrap so first-install reliability does not depend on `setup.sh` step 2 running to completion. Currently the check exists in `hive update` (which fires on every update going forward) but NOT in the initial curl-bash flow.

---

## [1.5.10] — 2026-05-11

**`hive update` no-args path fixed on macOS bash 3.2.** Hetavi's v1.5.9 install hit `bin/hive: line 1744: filtered_args[@]: unbound variable` when running `hive update` with no extra arguments. The function declared `local filtered_args=()` and then expanded `"${filtered_args[@]}"` on an empty array. macOS ships bash 3.2 by default, where `${arr[@]}` of an empty array under `set -u` (nounset, which `bin/hive` enables on line 9) raises "unbound variable". Newer bash versions (4+) and zsh tolerate it, which is why this never surfaced on developer machines.

### Fixed

- **`cmd_update` uses the `${arr[@]+"${arr[@]}"}` idiom for empty-array expansion under `set -u`.** This is the canonical bash 3.2-compatible pattern: expand the array only if it has been set, otherwise expand to nothing. Applied to both `for arg in "${@+"$@"}"` (the outer arg loop) and `_update_run_full_flow_with_revert ${filtered_args[@]+"${filtered_args[@]}"}` (the inner call). Effect: `hive update` with no args now works on any bash version including macOS bash 3.2.

### Notes

- `hive update --check` was already working — it took a different code path that didn't hit the empty-array expansion. Only the no-args `hive update` (the action path) was broken.
- Other `local -a foo=()` declarations in `bin/hive` (lines 885, 1053) are guarded by `[ "${#foo[@]}" -gt 0 ]` length checks before expansion — those are safe.

---

## [1.5.9] — 2026-05-11

**Section-aware `.env.example` + section-aware `hive doctor`.** v1.5.8's doctor still treated every key in `.env.example` as required and WARN-flagged optional integrations (1Password, dashboard bridge) as missing on every install that didn't use those features. The deprecated `DISCORD_OWNER_ID` and `DISCORD_AUTHORIZED_USERS` keys (replaced by `config/users.local.yaml` in v1.4.7) also kept appearing on the WARN list even though new installs are expected NOT to set them. v1.5.9 introduces three section markers in `.env.example` and teaches the doctor to honor them.

### Fixed

- **`.env.example` rewritten with three section markers:** `=== REQUIRED ===` (Hive will not function without these), `=== OPTIONAL ===` (only for specific integrations), and `=== DEPRECATED ===` (preserved for v1.4.x back-compat but new installs should not set them). The deprecated `DISCORD_OWNER_ID` and `DISCORD_AUTHORIZED_USERS` keys are now in a commented-out DEPRECATED section so they neither appear in fresh `.env` files nor trigger doctor warnings.
- **`hive doctor` `.env key coverage` check is section-aware.** Only keys in the `=== REQUIRED ===` section produce WARN findings when missing from user's `.env`. OPTIONAL and DEPRECATED keys are silent. End-user impact: fresh installs that don't use 1Password or the dashboard chat-mirror will see **zero env-key-coverage warnings** in doctor output. The `users.local.yaml` migration is also clean — no nag about deprecated keys.

### Notes

- Existing installs running `hive update` to v1.5.9 will pick up the new `.env.example` (the framework's copy at `~/neato-hive/.env.example`), but their existing `.env` file is **preserved untouched** — `hive update` never overwrites user state. The doctor improvement applies immediately regardless of which `.env` they have.
- F-12 (new follow-up): doctor could additionally validate **paired OPTIONAL keys** — e.g., warn if `OP_SERVICE_ACCOUNT_TOKEN` is set but `OP_VAULT_NAME` is not. Not urgent.

---

## [1.5.8] — 2026-05-11

**`hive doctor` cleanup + `announce_on_boot` default for house-md.** Hetavi's first clean `hive doctor` run on v1.5.7 surfaced four stale or misconfigured checks. v1.5.8 removes the false-alarms, treats tarball installs as first-class instead of git-clone-only, and ships `announce_on_boot: true` for house-md by default so fresh installs do not need a manual `agents.local.yaml` overlay to clear the warning.

### Fixed

- **Per-agent file integrity check no longer requires `CRITICAL-RULES.md` or `TOOLS.md`.** `CRITICAL-RULES.md` lives in `shared/` (loaded into every agent's prompt via the builder), not per-agent. `TOOLS.md` is deprecated — agents inherit tools from `config.yaml` plus their `AGENTS.md`. The doctor now checks for `IDENTITY.md`, `AGENTS.md`, `SOUL.md`, `USER.md` only. Stale checks were flagging every install as broken since the v1.4.7 user-identity work.
- **Fleet drift check now excludes `hive-dashboard` from the "unexpected in PM2" list.** Previously only `hive-runner` was excluded, so `hive-dashboard` (started by `ecosystem.config.cjs` like the runner) was flagged with `INFO  PM2 has hive-dashboard, not in config (manually started? leftover?)` and recommended deletion — which would have torn down the dashboard the user just stood up. The check now whitelists both framework daemons.
- **"Up to date" check is tarball-install aware.** Previously the check ran `git fetch origin main` and reported WARN when the fetch failed, which is the normal state for tarball installs (no git remote). v1.5.8 falls back to comparing the local `VERSION` against `https://neato-hive-site.vercel.app/releases/current.json`. If they match → OK. If local is older → WARN with `hive update`. If both git and the website API are unreachable → WARN (genuine offline). The check title is also renamed from "Up to date with origin/main" to "Up to date" since it is no longer git-specific.

### Changed

- **`config/config.yaml` now ships `announce_on_boot: true` for house-md by default.** Required for delegation/wake auto-resume after machine restart. Previously this was only set in `agents.local.yaml` overlays on owner-built hives; fresh tarball installs did not have it and `hive doctor` flagged WARN on every install. New installs and existing installs running `hive update` will both pick up the default.

### Notes

- Doctor's `Memory directory MISSING` finding for `agents/<name>/memory/` is intentional — the directory is auto-created on first daily-memory write. v1.5.8 leaves the MISSING state as-is; it self-heals on first agent operation. Future polish would downgrade the finding from MISSING to INFO/optional.
- Eight point releases (v1.5.0 → v1.5.8) in one session. Each release shipped a real fix to a real bug; the CHANGELOG explains the cascade.

---

## [1.5.7] — 2026-05-11

**Step 9 health check stops false-failing on working installs.** Hetavi's v1.5.6 fresh install showed house-md logging into Discord successfully and PM2 reporting `online`, but step 9 still reported "House MD not online (pm2 jlist status: online\nerror)" and halted the wizard. Root cause: the embedded python health-check used a bare `except:` clause, which catches `SystemExit` raised by `sys.exit(0)`. Python printed "online", then called `sys.exit(0)`, the bare except caught the resulting SystemExit and printed "error" too. The shell variable `$PM2_STATUS` ended up containing literally "online\nerror", which failed the exact-match `[ "$PM2_STATUS" = "online" ]` check on every successful install.

### Fixed

- **`setup.sh` step 9 health check no longer mis-reports working installs as broken.** Replaced bare `except:` with `except Exception:` (does NOT catch SystemExit), replaced `sys.exit(0)` with `for/else + break` (no SystemExit raised at all), and added a defensive `| head -n1` to the shell pipe so any future multi-line drift gets clipped to first line.

### Notes

- This bug has been latent since v1.5.0 — it only became visible because every other upstream blocker (config leak, missing `ws`, npm/pnpm mismatch, missing `tsconfig.json`, missing `src/`) is now fixed. Fresh installs finally reached this check for the first time and it falsely reported failure.
- v1.5.6 installs that were "stuck" at step 9 are actually fully functional — house-md is online, logged into Discord, listening on its channel. The wizard just lied about the state. On those installs, marking step 9 as complete manually unblocks step 10:
  ```bash
  mkdir -p /tmp && touch /tmp/.hive-setup-step9-ok
  # Or, since v1.5.7's health-check works, simpler:
  hive update && ./setup.sh --resume
  ```

---

## [1.5.6] — 2026-05-11

**Tarball ships `src/` and `scripts/`.** v1.5.5 added `tsconfig.json` to the tarball, which fixed the previous "tsc prints help" failure. But once `tsc` could find the config, it complained that the `include: ["src/**/*"]` pattern matched zero files — because `src/` was never staged. The release script shipped pre-built `dist/` but not the TypeScript source it was built from. `setup.sh` step 9's `pnpm run build` couldn't find any inputs to compile, exited 2. Adding `src/` (and `scripts/` for completeness — `release.sh`, `release-audit.sh`, `release-publish.sh`, `install-prereqs.sh`) to the staging list.

### Fixed

- **`src/` now ships in the release tarball.** Required for `setup.sh` step 9's `pnpm run build` to have inputs to compile. Adds ~500 KB to the tarball (TypeScript source for `src/core/`, `src/discord/`, `src/local-bridge/`, `src/runner/`, `src/cli/`, `src/safety/`, `src/tools/`, and matching test files).
- **`scripts/` now ships in the release tarball.** Previously framework operators on user machines couldn't run `scripts/release-audit.sh` or `scripts/install-prereqs.sh` because the directory wasn't packaged. Doesn't expose anything sensitive — these are tracked framework utilities.

### Notes

- `dist/` is still pre-built in the tarball, so step 9's rebuild is technically redundant for tarball installs. It now succeeds because `src/` and `tsconfig.json` are both present.
- F-8 remains open: short-circuit step 9's rebuild if `dist/` exists and is fresh. Would skip ~3 seconds of redundant work per fresh install. Not urgent.

---

## [1.5.5] — 2026-05-11

**Tarball includes `tsconfig.json`.** v1.5.4's tarball was missing `tsconfig.json`, so `setup.sh` step 9's `pnpm run build` invocation found no config, `tsc` printed help text instead of compiling, and exited with code 1. Step 9 reported "TypeScript compilation errors are shown above" but the output was just tsc's help banner. Adding `tsconfig.json` (and `README.md` + `CHANGELOG.md` for local docs access) to the top-level files staged into the release tarball.

### Fixed

- **`tsconfig.json` now ships in the release tarball.** Previously the staging step in `release.sh` only included `package.json`, `pnpm-lock.yaml`, `setup.sh`, `ecosystem.config.cjs`, `.env.example`. `tsconfig.json` is tracked in git at the root but was never included in the explicit top-level file list. Added.
- **`README.md` and `CHANGELOG.md` also ship now.** Useful for users running `cat ~/neato-hive/CHANGELOG.md` to see version history locally.

### Notes

- `dist/` IS pre-built in the tarball by `release.sh` before staging, so step 9's `pnpm run build` is technically redundant for tarball installs (only needed for github-clone installs). v1.5.5 keeps the redundant rebuild because it doubles as a sanity check that the local environment can compile, but the rebuild now succeeds because `tsconfig.json` is present.
- F-8 (new follow-up): consider an `if [ -d dist ] && [ "$(find dist -newer pnpm-lock.yaml | head -1)" ]; then skip build; fi` short-circuit in setup.sh step 9 so tarball installs don't waste time rebuilding what release.sh already built.

---

## [1.5.4] — 2026-05-11

**Root-cause fix for step 9.** v1.5.3 exposed the npm crash that had been silent through v1.5.0 → v1.5.2; v1.5.4 actually fixes the underlying mismatch. The repo declares `"packageManager": "pnpm@10.30.3"` and ships `pnpm-lock.yaml`. `install.sh` runs `pnpm install`, producing a pnpm-shaped `node_modules` with the `.pnpm/` symlink store. The previous `setup.sh` step 9 then ran `npm install` on top, which crashed inside `@npmcli/arborist` with `TypeError: Cannot read properties of null (reading 'matches')` because npm cannot reconcile pnpm's symlink layout. Diagnosis credit: a Claude Code instance running on a fresh Mac mini install.

### Fixed

- **`setup.sh` step 9 now uses `pnpm install --frozen-lockfile` + `pnpm run build`** instead of `npm install` + `npm run build`. Matches `packageManager` field and the existing lockfile. No more arborist crash on the pnpm-shaped `node_modules` from `install.sh`. **End-user impact:** fresh `curl ... | bash` installs of v1.5.4 will pass step 9 cleanly without manual intervention.
- **`setup.sh` step 2 now runs `corepack enable`** so `pnpm` is guaranteed on PATH before step 9 needs it, regardless of whether `install.sh`'s `npm install -g pnpm` substep ran. Falls back to `corepack prepare pnpm@10.30.3 --activate` then `npm install -g pnpm` if corepack is unavailable (Node <16).
- **`npm link` for the hive CLI install is retained.** `bin/hive` is a standalone bash script that does not read package contents; it only needs to be symlinked onto PATH. `ensure_npm_global_path` checks `npm config get prefix`, so keeping `npm link` keeps that helper working unchanged.

### Notes

- v1.5.3's diagnostic improvements (no more `--silent`, hard-fail with recovery hints, inline `pm2 logs` + `ps aux` on health-check failure, 6-second wait) are all retained.
- F-7 (new follow-up): the framework no longer needs the `npm install -g pnpm` substep in `install.sh` — corepack handles it. Cleanup leaf for a future release.

---

## [1.5.3] — 2026-05-11

**Setup wizard diagnostics rewrite (Step 9).** Step 9 of `setup.sh` was failing for fresh-install users with no actionable output. Every command in the step was suffixed with `--silent`, swallowing the real failure and producing an opaque "House MD failed to start" message regardless of root cause. v1.5.3 rewrites step 9 to surface every error verbatim, hard-fail on critical conditions (`npm install`, `npm run build`, `npm link`, hive-on-PATH, `pm2 start`), and emit a multi-line diagnostic block on health-check failure that runs `pm2 list`, `pm2 logs house-md`, and a `ps aux` rogue-process check inline so the user sees the actual crash reason instead of needing a second support round.

### Fixed

- **`setup.sh` step 9 no longer hides errors behind `--silent`.** Removed `--silent` from `npm install`, `npm run build`, `npm link`, `pm2 save`. Build / install / link failures now print full error output and halt setup with a recovery suggestion specific to the failure mode.
- **`npm link` failure is now a hard halt with a specific recovery hint** (most common cause is npm-global-prefix permissions; the wizard prints the exact `chown` command).
- **`hive` CLI not on PATH after `npm link` is now a hard halt**, not a warning. The previous warning made users continue setup and then report `hive: command not found` later. v1.5.3 halts with the precise `export PATH=…` line tailored to their `npm config get prefix`.
- **`pm2 start house-md` failure is now caught and explained** (previously silent if pm2 daemon was wedged).
- **Health-check wait extended from 3s to 6s.** 3s was racing with house-md's Discord login on first boot; valid installs were intermittently reporting failure.
- **Health-check failure now prints `pm2 list`, `pm2 logs house-md`, and a rogue-process `ps aux` block** so the user sees the actual crash reason in the setup output, no separate debugging round required.

### Notes

- No runtime behavior changes; framework, dashboard, install path, and agent processes are unchanged. Only `setup.sh` step 9 is modified.
- Credit for the diagnosis goes to a Claude Code instance running on a fresh Mac mini install — the `--silent` smell was identified there before this release.
- F-6 (new follow-up): consider splitting step 9 internally into 9a (install/build/link) and 9b (start/verify) with separate state-save markers so `--resume` can skip parts that already worked. v1.5.3's idempotent re-run is acceptable but slow on subsequent retries.

---

## [1.5.2] — 2026-05-11

**Critical fixes. v1.5.1 yanked.** v1.5.1 shipped two install-blocking bugs that are corrected here. The v1.5.1 tarball has been removed from the website and `current.json` rolls forward to v1.5.2.

### Fixed

- **`ws` package now an explicit dependency.** `src/local-bridge/index.ts` imports `WebSocket from "ws"`, but `ws` was only available transitively (via `discord.js → @discordjs/ws`). pnpm's strict `node_modules` layout does not hoist transitive deps, so `node dist/index.js` failed at load time with `ERR_MODULE_NOT_FOUND: Cannot find package 'ws'`. This blocked `setup.sh` step 9 on every fresh install where pnpm was the install path. `ws@^8.20.0` and `@types/ws@^8.18.1` are now direct deps. **End-user impact:** fresh installs of v1.5.2 will pass step 9 cleanly; existing v1.4.x or v1.5.0 installs upgrading via `hive update` pick up the fix automatically.
- **`scripts/release.sh` no longer leaks gitignored files into the tarball (F-5).** v1.5.1 used `cp -a` to stage `config/`, `shared/`, etc. into the tarball, which copied gitignored files (`config/users.local.yaml`, `config/agents.local.yaml`, `config/config.yaml.backup-*`, `shared/exchange/*` — 318 files in the originating Hive). Staging now uses `git ls-files -z | tar --null -cf - -T -` per tracked directory, which respects `.gitignore` exactly. `dist/` and `dashboard/node_modules/` remain explicitly included (gitignored but intentionally packaged — build output + pre-installed runtime deps). **No credentials were ever in scope** — tokens live in `.env`, which was never in the staging list.

### Added

- **`templates/agent-builder/`** — spec interviewer template. Produces buildable agent specs via a structured 13-section schema. Output dir: `agents/<self>/specs/`. Pure interview-then-spec; no scaffolding or PM2 work.
- **`templates/chief-of-staff/`** — planning + technical-review layer template. WBS decomposition, atomic-leaf granularity, structured project files, review modes, replanning, post-mortems. Executor references genericized for any coding-backend agents the owner has created.
- **`templates/monday-assistant/`** — Monday tickets + Gmail read + Calendar template. Ships with `BOOTSTRAP.md` for first-session workspace mapping. Monday API token reference parameterized.

### Removed

- **`templates/site-skeleton/`** — static-site snapshot of `Daniel-Neato/neato-hive-site` removed from `templates/`. The live GitHub repo is the source of truth (`gh repo clone Daniel-Neato/neato-hive-site` is the recovery path).

### Notes

- Optional per-agent `claude_config_dir` for multi-account Anthropic auth (commit `fb232a6`).
- v1.5.1 was published at 2026-05-11T20:13:32Z and yanked at ~2026-05-11T21:25Z (~70 minute exposure window). The tarball is no longer downloadable from `neato-hive-site.vercel.app`.
- Released by raymond-holt via direct ceremony.

---

## [1.5.1] — 2026-05-11 (YANKED)

This release was published at 2026-05-11T20:13:32Z and **yanked at ~2026-05-11T21:25Z** due to two install-blocking bugs (missing `ws` direct dep) and a packaging leak (`cp -a` in `release.sh` included gitignored files in the tarball). The tarball is no longer available from the website. End users see v1.5.0 as `current` until v1.5.2 publishes. **Do not install v1.5.1.** Both issues are fixed in v1.5.2 above.

---

## [1.5.0] — 2026-05-09

**Website distribution + local dashboard.** End users no longer install via
`git pull` from GitHub. The new flow:

```bash
curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash
```

...fetches the tarball from the website, verifies SHA-256, extracts to
`~/neato-hive`, generates a dashboard token, prints the dashboard URL. A
new local dashboard (port 7777, Tailscale-friendly) provides Overview,
Agents, Doctor, and Updates pages with token auth.

### Added

- **`install.sh`** at framework root — fresh-install bootstrap for the
  `curl ... | bash` UX. Auto-installs missing prereqs (Node >= 18, pnpm,
  pm2, tar) via Homebrew (macOS) or apt-get (Ubuntu) by default;
  `--no-install-prereqs` opt-out and `--interactive-prereqs` per-prompt
  also supported.
- **`scripts/install-prereqs.sh`** — standalone prereq detection
  (`--check-only` / `--install` / `--auto`) with JSON envelope (v1) for
  consumption by future GUI installers.
- **`hive update`** rewrite: tarball-based with atomic-overlay swap,
  rollback (`hive update --rollback`), state-file emission for SSE
  progress (`~/.neato-hive/state/update-<id>.jsonl`), v1.4.x -> v1.5.0
  implicit migration handler.
- **`hive update --check --json`** mode for dashboard + CLI scripting.
- **`hive doctor --json`** mode for dashboard consumption.
- **`hive dashboard token` / `rotate-token`** subcommands.
- **Local dashboard** (`hive-dashboard` PM2 process, port 7777,
  `0.0.0.0`): Express backend + vanilla-MPA frontend.
  - Endpoints: `/api/health`, `/api/status`, `/api/agents`,
    `/api/agents/:name`, `/api/doctor`, `/api/update/check`,
    `/api/update/apply`, `/api/update/status/:id`,
    `/api/update/progress/:id` (SSE), `/api/backups`, `/api/tasks`,
    `/api/runner-events`, `/api/sessions/active`.
  - Token auth via `Authorization: Bearer` header OR `?token=` query
    param (the latter for native `EventSource` SSE).
  - Pages: `/login.html`, `/` (Overview), `/agents.html`, `/doctor.html`,
    `/updates.html`. Tasks + Backups pages deferred to v1.5.x.
- **Cloud Run + Cloud SQL backend** (`hive-releases-api`): FastAPI service
  serving `/api/current` from a `releases` table in `neato-os-db`.
  Deployed via Vercel rewrites at
  `https://neato-hive-site.vercel.app/api/current`.
- **`scripts/release.sh`** + **`scripts/release-audit.sh`** +
  **`scripts/release-publish.sh`**: tarball release pipeline. The publish
  script pushes tarball + checksums + changelog + current.json +
  index.json + install.sh to the site repo, triggering a Vercel rebuild.
- **`setup.sh --post-install`** flag + auto-detection
  (`detect_post_install_state`): post-fresh-install handoff banner.

### Changed

- `hive update` body cuts over from git-pull to the new tarball flow
  (`_update_run_full_flow_with_revert`). `--rollback` (C.3) and
  `--check` (C.5) branches preserved at the top.
- `dashboard/middleware/auth.js` extracted `tokenFromRequest()` helper:
  header-first, query-param fallback. Constant-time compare preserved.
- Dashboard token auto-ensured during agent bootstrap (via
  `cmd_bootstrap`) when missing.

### Deprecated

- `hive update --internal-post-pull` — v1.4.x self-exec relic; tarball
  install has no `.git/` directory so post-pull self-exec is impossible.
  Flag is now silently stripped with a deprecation warning.

### Removed

- The git-based `hive update --check` block (lines 1447-1487 in
  pre-v1.5.0 `bin/hive`) is replaced by the API-based `_update_check`
  (C.5). Tarball installs have no `.git/` to fetch from.

### Fixed

- `scripts/provision-v1.5.0.sh`'s `ensure_project_link()` correctly
  parses Vercel's "already connected" output and treats it as success
  (was: incorrectly aborting on idempotent re-runs).

## [1.4.9] — 2026-05-06

**Self-healing bootstrap.** `hive update` now self-execs after `git pull`
so post-pull logic runs on the freshly-pulled `bin/hive`, not the old one.
Sanity checks that previously warned "X is not running, here's the recovery
command" now auto-run the recovery command and only fall through to a
warning if the auto-fix itself fails. New `hive bootstrap` subcommand
exposes the reconciliation as a standalone command for manual triggering
and `hive doctor --fix` integration.

### Added

- `hive bootstrap` subcommand. Idempotent. Reconciles PM2 daemons against
  `ecosystem.config.cjs`. Future framework-required state checks hook in
  here.
- `cmd_update` phase split: phase 1 (pre-pull state checks + git pull) on
  whatever bin/hive is running; phase 2 (build, reconcile, restart, doctor)
  on the freshly-pulled bin/hive via `exec`. Sentinel env var
  `HIVE_UPDATE_PHASE=post-pull` prevents recursion.

### Changed

- Sanity check (hive-runner not running after update) now
  invokes `cmd_bootstrap` to auto-fix instead of just warning.
- `cmd_doctor --fix` now calls `cmd_bootstrap` as part of its sweep.

### Migration note

Hives that pre-date v1.4.9 need ONE manual `hive update` (or
`pm2 startOrReload ecosystem.config.cjs && pm2 save`) to acquire the
self-healing logic. From v1.4.9 forward, framework changes that introduce
new PM2 daemons or post-update sanity checks will self-heal automatically
on the SAME update that introduces them, not the next one.

This is a fundamental property of "the updater is the thing being updated"
— v1.4.9 closes the loop by self-exec'ing after pull, but that closure
only takes effect once v1.4.9 is itself running.

### Manual smoke procedure

1. `pm2 delete hive-runner` — confirm gone with `pm2 list`.
2. `hive bootstrap` — hive-runner reappears in `pm2 list`, `pm2 save` fires.
3. `hive bootstrap` again — idempotent, no duplicate process, no error.
4. `hive update --check` — works the same as before (no exec to phase 2).
5. (Optional) On a separate stale Hive: `hive update` completes without
   manual intervention; hive-runner is up at the end.

---

## [1.4.8] — 2026-05-06

**Wake closure telemetry.** Adds four new events to `data/runner-events.log`
emitted by the agent-side wake handler: `wake_picked_up`, `wake_turn_started`,
`wake_turn_complete`, `wake_archived`. Closes the observability gap between
the runner's `wake_enqueued` event (already present) and the agent's archive
of the wake file (filesystem-only). The next audit can now quantify wake-drop
rates per hop instead of guessing.

### Added

- `wake_picked_up` event — agent read the wake file. Includes `ageMs` (delivery
  latency from runner enqueue to agent pickup).
- `wake_turn_started` event — about to invoke `runAgent` for the wake prompt.
- `wake_turn_complete` event — `runAgent` returned. `status: "ok" | "error" |
  "exception"`. `durationMs`. `errorMessage` if applicable.
- `wake_archived` event — wake file moved to `wake/processed/`.
- `hive task status <task-id>` CLI — prints the full event chain for a task,
  with relative timestamps. Useful for diagnosing "where did this task hang."

### Changed

- `src/discord/bot.ts` `pollWakeQueue` emits the four new events at the
  appropriate points. Wake delivery semantics unchanged.

### Notes

- This is observability only. No behavior changes. Existing wake handling is
  untouched. Old log entries without these events render fine — the CLI
  prints what's available and notes gaps implicitly via missing rows.

---

## [1.4.7.1] — 2026-05-06

**Cross-agent `hive task launch` gate (infrastructure enforcement of LESSONS.md 2026-05-06).**
Refuses to launch a task when `HIVE_AGENT_NAME` is set and does not match `--agent`.
Promotes the "delegating agents NEVER dispatch workers on each other's behalf" rule
from behavior-file persuasion to infrastructure-level law. Agents that don't read
their LESSONS.md still can't accidentally fan out workers under another agent's name.

### Added

- New exit code 3 in `hive task launch` — "blocked by policy" — distinct from
  exit 1 (write failure) and exit 2 (bad args).
- `src/cli/task-launch.test.ts` — covers the gate (block, self-dispatch allowed,
  owner-from-terminal allowed, exit-code distinctness).

### Changed

- `src/cli/task-launch.ts`: cross-agent gate inserted after arg parsing.
  Owner running the CLI from a terminal (no `HIVE_AGENT_NAME` env) is unaffected.
  Runner spawning child workers from task files is unaffected (it reads task
  files directly, doesn't shell out to `hive task launch`).

### Notes

- The escape hatch is `HIVE_AGENT_NAME= hive task launch --agent X ...` (unset
  the env var inline). Documented in the block error message. Requires deliberate
  action by the agent; goal is preventing accidents, not sandbox-grade isolation.

---

## [1.4.7] — 2026-05-06

**User-identity model — `config/users.local.yaml`.** Replaces the
v1.4.4 `DISCORD_AUTHORIZED_USERS` env-var pattern with a proper user
table where one user can have N Discord IDs. The owner case is
"one human, multiple Discord accounts." Both accounts hit the gate
under the single owner user record; agent prompts can reference the
user by name instead of by Discord ID; the singular-owner concept
in code is reframed as the user with `primary: true`.

### Added

- `config/users.local.yaml` (gitignored) — primary config surface.
- `config/users.local.yaml.example` — copy-and-edit template for new Hives.
- `src/core/users.ts` — loader + validation + back-compat fallback.

### Changed

- `BotOptions` now takes a `UsersTable` instead of `ownerId` +
  `authorizedUsers`. Boot log line reflects the user table.

### Deprecated

- `DISCORD_AUTHORIZED_USERS` env var. Still works as a fallback when
  `config/users.local.yaml` doesn't exist; will be removed in v1.5.x.
- `DISCORD_OWNER_ID` env var. Same deprecation. The CLI / setup wizard
  in v1.5.0 will create users.local.yaml directly.

### Notes

- EscalateToOwner unchanged at the call site — already posts to the
  agent's user-facing channel, which both Discord accounts of the
  owner can see (channel-post pattern, not DM). The v1.4.4 CHANGELOG
  note that "EscalateToOwner still routes only to DISCORD_OWNER_ID"
  was misleading; the fix is in framing, not routing.
- Existing Hives without `users.local.yaml` keep working unchanged
  via the env-var fallback. No migration required.

---

## [1.4.6] — 2026-05-06

**Per-agent FIFO inbound queue — Bug #1 fix.** Eliminates silent hivemind
drops caused by the global boolean lock racing under concurrent inbound
load. Every inbound now enqueues into a per-agent FIFO; a single async
worker drains the queue one inbound at a time. No drops under concurrent
load.

### Fixed

- **(Bug #1) Replaced the global `hivemindProcessingActive` boolean lock
  with a per-agent FIFO inbound queue.** The boolean lock in
  `src/tools/messaging.ts` raced when two inbounds arrived for the same
  agent while one was mid-processing — the second could be silently
  dropped or clobber the first's session write. The new queue
  (`enqueueInbound` / `drainQueue`) serializes all inbound processing
  for an agent, eliminating the concurrent-handler race entirely.
  Empirical symptom (glados's first autonomous run): `SendMessage(to:
  atlas)` returned success but atlas's `session.json` never advanced.
- **`src/discord/bot.ts` hivemind handler refactored to enqueue.**
  The `messageCreate` handler now wraps the entire processing block in
  a `process()` callback and calls `enqueueInbound()`. The handler
  returns immediately after enqueue; processing happens in the
  background drain loop. `setHivemindProcessing()` calls removed —
  the queue handles processing-state tracking.
- **`src/tools/hive-tools-server.ts` block guard updated.** The
  SendMessage tool's `hivemindProcessingActive` boolean check replaced
  with `isHivemindProcessing()` which reads the queue's processing
  state. Same behavior, no race.

### Added

- `enqueueInbound()`, `isHivemindProcessing()`, `getInboundQueueStats()`
  queue primitives in `src/tools/messaging.ts`.
- Backpressure warning at depth 10 (soft threshold, log-only).
- `_resetInboundQueueForTesting()` test helper.
- 11 new tests in `src/tools/messaging-queue.test.ts` covering FIFO
  ordering, serialization, exception resilience, backpressure warning,
  stats reporting, and drain-cycle restart.
- 5 updated tests in `src/tools/messaging.test.ts` migrated from the
  legacy `setHivemindProcessing` API to the queue-based equivalents.

### Removed

- `hivemindProcessingActive` exported boolean.
- `setHivemindProcessing()` function.
- Both replaced by queue-internal state exposed through
  `isHivemindProcessing()` and `getHivemindProcessingState()`.

### Notes

- Receipt log (`data/hivemind-receipts.log`) still fires on every
  inbound — now from inside the per-inbound `process()` callback's
  `finally` block.
- Queue is in-memory (per-process = per-agent). Process exit mid-drain
  loses queued inbounds. Acceptable for v1.4.6; durable queue is a
  v1.5.x candidate if observed as a real failure mode.

### Validation strategy

After fleet restart, trigger a glados -> atlas -> glados delegation
roundtrip. Receipt log at `data/hivemind-receipts.log` should show
`sessionUpdated: true` for every entry. Pre-fix the entries were
intermittent.

---

## [1.4.5.1] — 2026-05-04

**`[NO_REPLY]` marker leak — closing two gaps left from PR #37.**

After v1.4.5 deployed, atlas's end-of-thread acks on `[Response from glados]` absorb turns posted verbatim to atlas's primary Discord channel — including the literal `[NO_REPLY]` marker. The owner saw it firing in production today. Glados spec'd a targeted patch (`shared/exchange/glados-house-md-v1.4.5.1-no-reply-leak-fix-20260504.md`); house-md found the matcher gap during review and folded it in.

### Fixed

- **`isNoReply()` matcher now recognizes trailing-on-own-line markers.** The previous matcher in `src/discord/relay-guards.ts` only matched leading markers (`[NO_REPLY]` alone, `[NO_REPLY] commentary`, `[NO_REPLY]\ncommentary`). Agents commonly write content first then the marker on a new line ("Acknowledged. ...\n\n[NO_REPLY]") — natural prose ordering. Matcher now also returns true when the trimmed text ends with `\n[NO_REPLY]`. Mid-text references like "the [NO_REPLY] convention" remain unmatched (still need own-line trailing).
- **`isNoReply()` guard wired into the response and escalation absorb branches** in `src/discord/bot.ts`. The request-relay branch already honored the marker (suppressing relay to #hivemind). The absorb-into-own-channel branches did not — they posted `resultText` unconditionally if non-empty. Now both branches check the marker before surfacing to the agent's user-facing channel.
- Net effect: agents following the v1.4.5 SendMessage block guidance ("end the turn cleanly with `[NO_REPLY]`") get clean suppression on every kind of inbound, regardless of whether the marker is leading or trailing.

### Tests

- 3 new cases in `src/discord/relay-guards.test.ts` covering trailing-marker patterns and explicit non-matches for trailing-LIKE-but-same-line text.
- Existing `isNoReply()` tests unchanged.

---

## [1.4.5]

### BREAKING (manual action required)
- **Cron jobs created before v1.4.5 will NOT auto-fire after upgrade.** v1.4.5 introduces per-agent cron ownership (#4 fix). Legacy entries lack the new `agent` field and are skipped on load with a warning. Re-create your crons via the CronCreate tool — they'll be tagged with the calling agent's name automatically.
- One-liner to enumerate legacy entries pre-upgrade: `jq '.[] | select(.agent == null)' data/cron-jobs.json`.

### Fixed
- (#2) Kind-aware SendMessage block. The block message now distinguishes between request, response, and escalation inbounds — agents get explicit workaround guidance instead of a generic "try again" message.
- (#3) Spawner detached + process-group kill. `bash -lc` tasks now spawn as process-group leaders (`detached: true`), and timeout/cancel signals the entire group via `process.kill(-pid, ...)`. Fixes orphaned inner child processes (e.g. `claude -p` workers) surviving after the outer bash shell was killed.
- (#4) Cron fan-out: each agent process now only fires its own crons. Was firing every cron in every agent, causing duplicate dispatches and cross-agent action confusion.
- (#5) cronRemove always attempts to stop the in-memory scheduled task, even if the JSON registry entry was already removed by another process. File watcher with 250ms debounce reconciles active tasks when the registry file changes on disk.

### Diagnostic instrumentation (#1 SendMessage→wake reliability)
- Added structured logging at every step of the hivemind inbound receive path. Prefix `[hivemind:receive]`.
- Added receipt log at `data/hivemind-receipts.log` — every inbound writes a JSON line with timestamp, from/to agent, taskId, kind, and whether the session advanced.
- **This is instrumentation, NOT a fix.** If you've been hitting hivemind drops, v1.4.5 will give us the data to root-cause in v1.4.6 — but the drops will continue until then. After upgrading, capture `data/hivemind-receipts.log` + the agent's PM2 log around any drop you observe and share with house-md.

---

## [1.4.4] — 2026-05-01

**Multi-user talk-access via `DISCORD_AUTHORIZED_USERS`.** Owner can now
grant additional Discord user IDs the same talk-access the singular
`DISCORD_OWNER_ID` has. Treated as peers for message + slash-command
gating; `DISCORD_OWNER_ID` stays the canonical "owner" for
`EscalateToOwner`, agent-side identity references, and any agent
behavior that says "the owner."

### Added

- **`DISCORD_AUTHORIZED_USERS` env var.** Comma-separated list of
  Discord snowflake IDs. Optional. When present, those IDs are
  unioned with `DISCORD_OWNER_ID` to form `allowedUserIds`, and both
  the message handler and slash-command handler check the union set
  instead of strict equality with `ownerId`.
- **Boot log line.** When additional authorized users are configured,
  the bot prints `[discord] Additional authorized users: <list>` on
  startup so operators can confirm the gate is correctly populated.

### Notes

- Backward compatible. Hives without `DISCORD_AUTHORIZED_USERS` set
  behave identically to v1.4.3 — `allowedUserIds` is just `{ownerId}`.
- No privilege tier today: authorized users are treated as full peers
  for talk-access. If finer-grained roles are needed later (e.g.
  read-only viewers, approval-only agents), they layer on top of
  this primitive.
- `EscalateToOwner` still routes only to `DISCORD_OWNER_ID`. The
  "buck stops here" person remains singular by design.

---

## [1.4.3] — 2026-04-30

**Coding-agent CLI guidance — replaced raw `tmux` with `hive task launch`.**
Atlas (and any other coding agent) was launching long-running Codex /
Claude Code tasks via raw `tmux send-keys` and asking the owner to ping
them when finished — because four canonical references still taught the
pre-autonomy-v1 pattern. The wake-on-complete capability shipped in
v1.3.x was effectively unused by the agents who needed it most.

### Fixed

- **`src/core/prompt-builder.ts` (`buildToolGuidance`)** — the
  auto-injected Coding CLIs section in every agent's system prompt
  now teaches `hive task launch --kind codex|claude --on-complete
  "<resume prompt>"` as canonical. Status checks via
  `data/runner-events.log` and per-task state files. Default timeouts
  (codex 90m / claude 30m) documented inline. Raw `tmux + cli` is
  flagged explicitly as a fallback for short interactive sessions
  only — never for delegated coding work.
- **`skills/codex-protocol/SKILL.md`** — full rewrite around the
  runner pattern. New sections: status checks, reply-to linkage for
  delegated codex work, and a fallback-only treatment of raw tmux
  for the hive-runner-down case.
- **`skills/hive-architecture/SKILL.md`** — Coding Backend Patterns
  section rewritten the same way for both Codex and Claude Code.
- **`templates/coding-agent/AGENTS.md`** — Availability Doctrine
  steps 3–5 updated so newly-built coding agents inherit the right
  pattern from day one.

No code-logic changes; pure docs/string content. Build clean,
246/246 tests pass.

---

## [1.4.2] — 2026-04-30

**Doctor Check 3 — auto-migrate legacy installs.** Closes the gap that
made `hive doctor --fix` give up on installs without
`config/agents.local.yaml`. Lance's situation: legacy install on
v1.1.8 → v1.3.9, never ran `hive config migrate-agents`, so the
overlay didn't exist. Track B's auto-fix correctly identified the
missing `announce_on_boot: true` for house-md but bailed with a
manual two-step: "Run 'hive config migrate-agents' first, then
re-run 'hive doctor --fix'." Owner accepted the migration itself but
asked us to make it automatic.

### Fixed

- **Doctor Check 3 auto-invokes the migrator when overlay is
  missing.** When `hive doctor --fix` encounters config-schema drift
  on a Hive without `agents.local.yaml`, it now silently runs the
  existing migrator (`cmd_config_migrate_agents`), verifies the
  overlay was created with the agent's block, and proceeds to inject
  the missing key. The migrator is safe to invoke non-interactively
  (no prompts, refuses to overwrite an existing overlay, always
  backs up `config.yaml`).
  - **Failure case 1:** migrator non-zero → surface its stderr and
    skip the auto-fix for that agent.
  - **Failure case 2:** migrator returned 0 but the overlay or the
    target agent's block is still absent → surface migrator output
    and skip.
  - **Edge case:** overlay exists but missing the target agent's
    block (rare — operator hand-crafted the overlay) → migrator
    refuses to run (won't overwrite), so this stays manual with a
    clear breadcrumb pointing to the fix.
- Re-running `hive doctor --fix` on an already-migrated Hive is a
  no-op (existing path unchanged — direct injection into the
  overlay's existing agent block).

### Notes

After Track B's `hive update` integration runs `hive doctor --fix
--yes` as the final update step, this means: a legacy install that
upgrades to v1.4.2 gets the overlay created, agent set migrated, and
schema-drift fixed (e.g., `announce_on_boot: true` re-added to
house-md) automatically — no manual intervention beyond the existing
update prompt. The agent restart that's already part of `hive update`
picks up the new config on the next cycle.

Trigger and spec: house-md follow-up to PR #35,
`shared/exchange/house-md-atlas-quick-follow-up-to-pr-35-close-the-legac-20260430.md`.

---

## [1.4.1] — 2026-04-30

**`hive doctor` strategic checks (Track B).** Doctor becomes the durable
migration mechanism — every future feature that adds a daemon, config key,
or env var gets migration coverage for free, instead of breaking downstream
installs silently.

### Added

- **Six new strategic checks in `hive doctor`:**
  1. Fleet drift — declared agents vs PM2 list (auto-fix: start missing).
  2. Runner drift — hive-runner online (auto-fix: restart).
  3. Config schema drift — per-agent expected keys, starting with
     `house-md/announce_on_boot` (auto-fix: inject into overlay YAML).
  4. Plist drift (macOS) — UserName + PM2_HOME validation (surface only).
  5. `.env` drift — keys in `.env.example` but missing in user's `.env`
     (surface only).
  6. Behavior file drift — extends per-agent file check with LESSONS.md
     and MEMORY.md as INFO-level advisory.
- **`--fix` and `--yes` flags** for `hive doctor`:
  `--fix` auto-applies safe fixes; `--fix --yes` suppresses prompts
  (used by `hive update` integration).
- **Post-update doctor sweep** — `hive update` calls
  `hive doctor --fix --yes` as its final step. Output suppressed on
  clean runs.
- **`HIVE_AGENT_NAME` env var** set at startup in `src/index.ts` for
  belt-and-suspenders self-update detection (complements v1.4.0's
  parent-process walk).

---

## [1.4.0] — 2026-04-30

**Hivemind autonomy-v1 hardening + self-update safety.** Fixes the two
failure modes that broke Lance's hivemind orchestration test on
2026-04-30 (delegation chain with mid-task `EscalateToOwner` never
reached the delegator), plus the self-update suicide that forced his
House MD to manually split the framework upgrade flow.

The minor bump signals new behavioral contract: the `EscalateToOwner`
tool no longer promises auto-routing of post-resolution replies. Agents
must now explicitly close the loop with `SendMessage(kind=response,
task_id=...)`. The new task_id surfacing (Bug #4) makes that actionable.

### Fixed

- **(Bug #4) `task_id` now surfaces in inbound delegation prompt
  headers.** Previously the bot tracked the id internally to route
  auto-replies as `kind=response`, but never showed it to the receiving
  agent. The moment an agent called `EscalateToOwner` mid-turn, they
  had no way to recover the id for the eventual explicit close. Header
  format (when a task_id is present):
  ```
  [Message from atlas via #hivemind, task_id=t-abc123 — reply directly, do NOT use SendMessage]
  ```
- **(Bug #3 / Option B) `EscalateToOwner` documentation rewritten;
  auto-tag promise removed.** The previous tool description claimed
  that "when the owner answers, a fresh turn fires for you; THAT turn
  issues the resolved kind=response back to the delegating agent."
  That auto-tagging was never wired up — there's no persistent state
  tying an escalation to its original delegation, and resolution
  detection across owner-mediated turns is racy by nature. Tool
  description now tells agents unambiguously: capture the inbound
  `task_id`, escalate, then after the owner answers, call
  `SendMessage(to: <delegator>, kind: 'response', task_id: <id>,
  message: <result>)` explicitly. Without that explicit call the
  delegator's registry stays stuck waiting forever.
- **(Fix #3) Self-update detection in `hive update`.** When invoked
  from inside an agent process (the common shape: owner asks
  house-md to update the fleet, house-md runs `hive update` from
  its own bash), `pm2 restart all` would kill the running process
  mid-update — losing pm2 save, sanity checks, and changelog output.
  `cmd_update` now detects self via `HIVE_AGENT_NAME` env var or
  parent-process walk for `dist/index.js --agent <name>`, restarts
  every other agent, then schedules a deferred-detached
  `pm2 restart <self>` (6s delay) so the script exits cleanly first.
  Lance's House MD's manual workaround is now baked into the tool.

### Changed

- **`skills/hivemind/SKILL.md`:** New "Escalating to the owner
  mid-delegation" section with a worked end-to-end example
  (delegation → escalation → owner answer → explicit
  `SendMessage(kind=response)` close). The two non-obvious moves
  (capture id; explicit close) are called out so future agents don't
  rediscover them painfully.

### Notes

Same review/merge/deploy cadence as PR-A/B/C and PR #33. Code-only
verification (no VM testing). Track B (`hive doctor --fix-setup`
expansion for config-schema migrations) ships separately.

Trigger: Lance's hivemind orchestration test, 2026-04-30. Full
post-mortem in `shared/exchange/incoming-lance-troubleshoot-20260430.md`.
Spec: `shared/exchange/house-md-atlas-update-flow-and-autonomy-fixes-spec-20260430.md`.

---

## [1.3.10] — 2026-04-30

**`hive update` runtime migration — Track A.** Fixes a real downstream
breakage: a Hive owner ran `hive update` and ended up with no
`hive-runner` daemon in PM2, no `feat/agent-boot-announce` (v1.3.6)
firing, and silent no-ops for delegation/wake/end-to-end task flow.

Root cause: four compounding gaps in the update path that left the
PM2 process list out of sync with `ecosystem.config.cjs` whenever a new
daemon was added to the framework.

This release is a runtime migration. No new functionality; existing
healthy installs see no behavioral change (every step is idempotent).
Track B (a follow-up `hive doctor --fix-setup` expansion for
config-schema migrations like `announce_on_boot` defaults, .env key
drift, etc.) ships separately.

### Fixed

- **(A1) `ecosystem.config.cjs` is now pulled by `hive update`.** It
  was missing from `framework_paths`, so downstream installs never
  received updated copies. Future schema changes (env vars, new
  daemons) now propagate cleanly.
- **(A2) PM2 daemons reconciled via `pm2 startOrReload` after build.**
  `pm2 restart all` only restarts existing procs — it never adds new
  ones. After build, the update now runs
  `pm2 startOrReload ecosystem.config.cjs --update-env` so newly-added
  daemons (hive-runner today; future daemons later) get registered on
  installs that didn't have them before.
- **(A3) `setup.sh` installs `hive-runner` on fresh installs.** The
  wizard predates v1.3.0 and never gained this step. Even fresh
  installs after v1.3.0 silently lacked the daemon. Now starts
  `hive-runner` immediately after `house-md`, gated on the ecosystem
  file existing.
- **(A4) Post-update sanity check.** After `pm2 restart all` succeeds,
  the update verifies `hive-runner` is in `pm2 jlist`. If not, prints
  a non-blocking warning with a one-line recovery command — visible
  failure beats silent failure.

### Compatibility

Idempotent across the board. Existing installs that already have
`hive-runner` registered see no change in behavior — `startOrReload`
reloads the daemon cleanly and the post-update check passes silently.

---

## [1.3.9] — 2026-04-30

**Setup wizard hardening — PR-B of the CLI audit fix series.** Hardens
`setup.sh` against data loss, silent failures, and footguns documented
in the 2026-04-30 audit. 12 findings across 4 phases.

### Fixed

- **(P0-1) `.env` merge instead of overwrite.** `cat > .env` in Step 6
  blew away every existing key on re-run. New `env_upsert()` helper
  replaces keys in-place and preserves all others (including
  ANTHROPIC_API_KEY, agent-specific tokens, etc.).
- **(P0-3) Step 9 fails loudly when House MD doesn't connect.** PM2
  start failure no longer falls through to `state_save 9`. The wizard
  halts with a clear resume hint, and a flag file drives the P1-5
  conditional banner.
- **(P0-4) Step 10 plist idempotence and corrupt-file handling.** Added
  corrupt-plist detection (plutil failure → prompt unstartup+reinstall).
  `state_save 10` now appears exactly once, gated on verified-correct
  plist. Wrong-plist path exits 1 instead of 0.
- **(P1-2) Discord token API ping.** Format-only validation with "use
  it anyway" escape replaced by an actual `/users/@me` API call. 401 →
  re-prompt with reset link. Network-down → warn and continue.
- **(P1-3) Path quoting.** `grep -q` → `grep -qF` for literal path
  matching in `ensure_npm_global_path`. Preflight warning when `$HOME`
  contains spaces.
- **(P1-4) Eager PATH export after `npm install -g`.** New
  `npm_install_global()` helper eagerly exports the npm prefix so
  `command -v` finds newly installed binaries within the same wizard
  run. All 4 global installs routed through it.
- **(P1-5) Final banner conditional on Step 9 verification.** Cheerful
  banner only when House MD connected successfully; warning banner with
  diagnostic commands otherwise.

### Changed

- **(P1-7) Discord walkthrough reorder.** Intents are now enabled and
  saved before the token is reset/copied, preventing navigating away
  from the Bot page after copying.
- **(P1-8) Optional-step prompt language.** Codex and GWS prompts use
  `(y/N)` to communicate that Enter defaults to skip.
- **(P2-4) Friendlier resume message.** Version-mismatch resume now
  says "Wizard updated … your existing config is preserved" instead of
  "Forcing fresh start."
- **(P2-5) Claude auth probe.** `claude auth status` is checked before
  the setup-token prompt. Already-authenticated users skip the
  redundant question.
- **(P2-6) Codex auth reminder in final banner.** When Codex was
  installed during setup, the final banner reminds the user to run
  `codex` to sign in.

### Compatibility

- No config schema changes.
- Backwards-compatible with existing `.setup-state` files (wizard
  version bump triggers a fresh re-run with the friendlier P2-4
  message).
- No TypeScript touched. All existing unit tests still pass.

### Upgrade

```
hive update
```

### Companion docs

- `shared/exchange/atlas-house-md-cli-audit-findings-20260430.md`
- `shared/exchange/atlas-house-md-cli-resolution-plan-20260430.md`

---

## [1.3.8] — 2026-04-30

**CLI completeness + hivemind loop termination — PR-C of the CLI audit
fix series.** Two small but production-painful issues, both surfaced
during the v1.3.7 post-deploy session:

### Fixes

- **(N1) `hive list`, `hive info`, `hive doctor`, and `hive config` now
  see the full fleet.** The bash CLI helpers (`list_agents`,
  `agent_exists`, `agent_behavior_dir`, `agent_channels`, plus inline
  `coding_backend` lookups) only read `config/config.yaml`. Operators
  store their actual fleet in `config/agents.local.yaml` — the
  gitignored overlay introduced by the `safety/config-overlay` change
  so `git pull` and `hive update` can never wipe the agent set. The TS
  runtime correctly merges base + overlay; the bash CLI was stuck on
  base alone. Symptom: PM2 had 6 agents, `hive list` showed 1
  (`house-md`), `hive info <non-house-md>` failed with "agent not
  found." Now: the bash helpers read both files in precedence order
  (overlay first, base second) and dedupe. Bonus catch: the previous
  inline `coding_backend` awk matched the literal substring inside the
  comment `# Codex MCP (for agents with coding_backend: codex)`, so
  `house-md` spuriously displayed `Codex` even though config.yaml
  never set it. Fixed.

- **(N2) Hivemind agent-to-agent ack chains can no longer loop
  unbounded.** Two layers of protection:
  - **`[NO_REPLY]` marker.** Agents emit `[NO_REPLY]` (alone, or as a
    leading marker followed by a space/newline + commentary) to
    gracefully end a hivemind exchange without spinning a new
    auto-reply. The bot recognises the marker via `isNoReply()` and
    skips the relay. The marker is the contract — agents should
    actively use it to close threads.
  - **Per-direction circuit breaker.** Counts auto-relays in a 60s
    sliding window keyed by `${from}->${to}`. After 5 in-window
    relays, further auto-replies from this bot to that correspondent
    are suppressed and a warning is logged. Catches future loop bugs
    even if the marker contract is broken on either side. Window
    decays naturally; normal behaviour resumes once traffic stops.

  Both guards apply only to the `isRequest` auto-reply path.
  `isResponse` and `isEscalation` already absorb-only and never
  relay — loops can't form there. The fix targets the actual leak
  in `bot.ts`, not the wider message-routing layer.

  Production trigger: 2026-04-30 atlas + house-md echoed "No
  response requested." back and forth ~14 times after a successful
  PR-A deploy, both trying to gracefully close. Owner intervened.
  PR-C ships the fix that would have terminated the loop at
  message 6.

### Tests

- New `src/discord/relay-guards.test.ts` covers `isNoReply`
  (9 cases — bare marker, trimmed, leading-with-commentary, mid-text
  negative, substring negative, similar-marker negative, empty) and
  `relayLoopGuardTripped` (5 cases — first-relay-clean,
  threshold-edge, opposite-directions-independent, window-decay, plus
  a regression replay of the 14-message production loop asserting
  trip occurs at THRESHOLD+1). All 246 project tests pass.

### Compatibility

- No config schema changes.
- No agent prompt changes required for N1 — automatic on first run
  after the upgrade.
- N2 is "best-effort even without buy-in": the circuit breaker fires
  regardless of whether agents adopt the marker. Adoption is encouraged
  via updated `skills/hivemind/SKILL.md` and a new rule in
  `shared/CRITICAL-RULES.md` (auto-injected into every agent's
  context).

### Upgrade

```
hive update
```

PR-A's branch validation will refuse the update from any non-default
branch, as expected.

---

## [1.3.7] — 2026-04-30

**`hive update` hardening — PR-A of the CLI audit fix series.** Surfaces
silent failures, validates branch state, and gives the user real
visibility into what changed. Targets the same surface every Hive user
hits on every release; addresses the 4 most painful issues from the
2026-04-30 CLI audit.

### Fixes

- **(P0-2) `npm install` and `npm run build` failures are no longer
  silently swallowed.** Both commands had `2>/dev/null` *and* ignored
  exit codes; a build break would fall through to `pm2 restart all`
  leaving the fleet pointing at a missing/stale `dist/`. The user saw
  `[hive] Update complete!` while everything crash-looped. Now: exit
  codes are checked, errors surfaced, the update aborts BEFORE PM2
  restart on failure, and recovery instructions are printed.
- **(P1-1) `hive update` refuses to run from non-default branches and
  detached HEAD.** The previous behaviour was to `git checkout
  origin/main -- <paths>` regardless of the user's current branch,
  silently patching framework files into a feature branch and creating
  mixed-commit confusion on the next merge. Now blocked early with a
  clear error.
- **(P1-6) PM2 restart status is no longer ambiguous.** The old code
  printed `"No PM2 processes to restart."` whether PM2 had zero
  processes (genuine no-op) or PM2 was alive but the restart actually
  failed. The latter case hid real failures. Now: count processes
  first, distinguish the two cases, exit non-zero on real PM2 failure
  with recovery instructions.
- **(P2-1) Pulled commits are listed after a successful update.**
  Multi-version jumps (e.g., v1.2.0 → v1.3.7) no longer feel like a
  black box — the user sees the actual commits being applied (capped
  at 10, with a hint to read the full log).
- **(P2-3) Post-overwrite confirmation prints when local framework
  changes are replaced.** Previously the wizard went silent after the
  `(y/N)` prompt — no signal that the overwrite actually happened.
- **(P2-2) `update --check` is documented in `hive help`.** Including
  an explicit note that it does run `git fetch` (refreshes refs) but
  makes no working-tree, dist/, or PM2 changes.
- **(P2-7) `package-lock.json` drift is reported.** When `npm install`
  regenerates the lockfile (because a framework update bumped a dep),
  a one-line note now informs the user. Adds a cross-platform
  `_hash_file` helper (macOS `md5 -q`, Linux `md5sum`).

### Why now

The CLI audit (atlas → house-md, 2026-04-30) found 19 issues across
`setup.sh` and `hive update`. PR-A ships the `hive update` slice first
because it's a small, well-contained surface (~120 lines of bash) that
every Hive user hits on every release. PR-B (setup.sh, much larger)
follows once PR-A has lived in the fleet for a release cycle.

### Compatibility

No config or behavioural changes for users on the happy path (clean
tree, default branch, healthy build). The only new exit-1 paths are:
build failure, branch mismatch, and PM2 restart failure — all of which
are real errors that previously were silently masked.

### Upgrade

```
hive update
```

(From the default branch — see P1-1 above.)

---

## [1.3.6] — 2026-04-29

**Agents announce themselves on restart.** When an opted-in agent's bot
restarts (manually or as part of a fleet wave), the agent automatically
posts a "back online" message to its primary Discord channel. Closes the
autonomy loop for the most important case: the operator no longer has
to ping an agent to know it's back.

### Why

The Hive supports `pm2 restart all`, but until v1.3.6 a restarted agent
sat silent until poked. For house-md (the agent operators talk to most),
this was friction every fleet upgrade. The new mechanism announces
readiness automatically — for any agent that opts in, on every boot.

### Architecture (runner-mediated, no synthetic-hivemind)

Reuses the v1.3.1 wake plumbing — no new transport.

```
1. Bot startup (after Discord ready):
     writes agents/<name>/state/boot.jsonl with one JSONL line:
       {"ts":"<ISO>","version":"<X.Y.Z>","pid":<pid>}
     (Only if announce_on_boot: true in agent config.)

2. Runner watches each agent's boot.jsonl on every poll tick.
   Tracks last-seen line per agent in-memory. On NEW line:
     enqueues wake at agents/<name>/wake/boot-announce-<ts>.json

3. Bot's existing wake-poller (every 5s) picks up the wake.
   Runs agentExecutor with mode=wake (silent path).

4. Agent calls the new sendToOwnChannel(message) MCP tool to post
   visibly to its primary channel. Wake-mode auto-post stays disabled
   (correct invariant from v1.3.1) — only the explicit tool call
   surfaces.

5. Wake archived to processed/, daily-memory line written.
```

### Added

- **`src/runner/boot-watcher.ts`** — pure beacon reader (parse JSONL,
  filter by last-seen timestamp, skip malformed lines).
- **`src/runner/wake-prompt-boot.ts`** — boot-announce wake prompt
  builder. Includes version, boot timestamp, recent task summary,
  daily memory tail, and explicit instruction to use
  `sendToOwnChannel`.
- **`src/tools/own-channel.ts`** — new `sendToOwnChannel(message)`
  MCP tool. Wraps the existing channel-send pipeline; targets the
  agent's primary channel from config.
- **`src/discord/bot-boot.ts`** — boot beacon writer. Atomic JSONL
  append, truncates to last 100 lines if file exceeds 1000 (prevents
  pathological growth on PM2 restart loops).
- **25 new unit tests** (232 total, was 207). Coverage: beacon
  parsing + last-seen filter + malformed-line resilience, prompt
  rendering for empty/few/many task states, channel resolution +
  error paths, beacon writer flag honoring + truncation, and a
  runner-integration test asserting end-to-end beacon → wake-file
  enqueue.

### Changed

- **`src/runner/index.ts`** — `RunnerState` gains `bootLastSeen` map.
  `pollOnce()` now also calls `pollBootBeacons(state)`. Quiet runner
  cutoff: each agent's last-seen initializes to runner-boot-time
  (NOT epoch 0), so old historical beacon entries do not fire on
  runner restart.
- **`src/discord/bot.ts`** — after Discord client `ready` event,
  calls `writeBootBeacon()` if `agentConfig.announce_on_boot === true`.
- **`src/tools/hive-tools-server.ts`** — registers
  `sendToOwnChannel` MCP tool.
- **`src/core/agent.ts`** — `AgentConfig` gains optional
  `announce_on_boot: boolean`, defaults `false`.
- **`src/runner/events-log.ts`** — `boot_wake_enqueued` event type.
- **`src/runner/wake-queue.ts`** — documented that boot-announce
  wakes coexist with task wakes in the same dir; no code change.
- **`templates/coding-agent/AGENTS.md`** + **`templates/generalist/AGENTS.md`**
  — documented the new `sendToOwnChannel` tool.

### Per-agent opt-in

Defaults to **off** for all agents. Operators enable per-agent in
`config/agents.local.yaml`:

```yaml
agents:
  house-md:
    channels: [house-md]
    behavior_dir: agents/house-md
    announce_on_boot: true   # NEW
```

`config/agents.local.yaml` is gitignored (since v1.2.2), so this PR
cannot pre-set the flag for any operator's existing house-md. Each
operator opts in on their own machine.

### How to roll out

1. `git pull && pnpm install && pnpm build`
2. Edit `config/agents.local.yaml`: add `announce_on_boot: true` under
   `house-md` (and any other agent you want auto-announces from).
3. `pm2 restart all && pm2 restart hive-runner && pm2 save`
4. Watch your `#house-md` channel — expect a "back online" message
   within ~10 seconds of the restart settling.

### PR

- #29 — `feat/agent-boot-announce`

---

## [1.3.5] — 2026-04-29

**Setup wizard: remove the optional 1Password step.** The wizard
collapses from 11 steps to 10. Pure simplification of the new-user
onboarding path. No agent runtime behavior changes.

### Why

The 1Password setup step was optional and opt-in, but it acted as a
friction wall for new users: those who don't use 1Password were
confused by the extra prompts, and those who DO use 1Password can
configure it after install via `shared/CREDENTIALS.md` (the canonical
reference). Removing the wizard step is structurally clean and lowers
the time-to-first-running-Hive for new operators.

### Removed

- `setup.sh` Step 8 (1Password) — the entire opt-in block, including
  service-account-token prompt, vault validation, and `.env` writes.
- `op:1password-cli` from the pre-flight `brew install` list. The
  `op` CLI itself is still installable manually for operators who
  want to wire 1Password later.

### Changed

- `setup.sh` steps renumbered: 9 → 8, 10 → 9, 11 → 10. All `print_step
  "N/11"` calls updated to `"N/10"`. Opening-screen total-step
  references updated.

### Backward compatibility

- **Existing installations are unaffected.** Removing the wizard step
  doesn't touch any `.env` file. Operators who already set
  `OP_SERVICE_ACCOUNT_TOKEN` and `OP_VAULT_NAME` continue to work
  with the agent-side credential helpers in `shared/CREDENTIALS.md`.
- **Fresh installations** simply skip the 1Password question. They
  can opt in later by manually adding the env vars and installing
  `op` per the credentials doc.

### Diff stats

- `setup.sh`: +33 / −139 (net −106 lines)
- No TypeScript touched. 207/207 unit tests still pass.

### How to roll out

`git pull && pnpm install && pnpm build`. No PM2 restart required —
this PR only affects the install wizard, not the runtime. Existing
agents keep running unchanged.

### PR

- #28 — `feat/wizard-remove-1password`

---

## [1.3.4] — 2026-04-29

**Update-flow visibility.** Closes the headline complaint that operators
"don't know if `hive update` actually did anything." Two layers of fix:
the version reporting becomes truthful, and the update command grows a
read-only check mode plus safer pre-restart prompting.

### Why

Before today, `hive version` printed a hardcoded `VERSION="1.1.9"`
regardless of what was actually installed. Operators would run
`hive update`, see "Update complete!", then later run `hive version`
and see 1.1.9 — and reasonably conclude the update had failed silently.
The hardcoded constant had never been bumped from the day it was added.

### Changed

- **`hive version`** now reads the version from `package.json` at
  invocation time. Single source of truth. The hardcoded constant is
  gone. Run on a fresh shell — prints whatever's in `package.json`.
- **`cmd_update`** post-update output now includes
  `Run \`hive version\` anytime to confirm.` — the durable signal an
  operator can re-check after the update terminal closes.

### Added

- **`hive update --check`** — read-only mode. Fetches `origin/main`,
  reports `Up to date — v<X> (<sha>)` or `Behind by N commit(s) —
  local v<X> (<sha>) → remote v<Y> (<sha>). Run \`hive update\` to
  apply.` No checkout, no rebuild, no PM2 restart, no state mutation.
- **`hive doctor`** gains two new lines at the top: the live version
  and an `Up to date with origin/main` status. Both run before the
  existing system checks. Best-effort on the network check — if the
  remote is unreachable, the doctor still completes and flags a
  WARN rather than failing.
- **Pre-update prompt** before `pm2 restart all`: "Any agent currently
  mid-task? Restarting now will fire duplicate wakes for any in-flight
  tasks. Press Enter to continue, Ctrl-C to abort." Bypassed with
  `hive update --yes` (or `-y`) for headless / autonomous loops.

### Tests

- All 7 spec checks pass: bash syntax, version output, --check
  read-only, doctor output, --help, status, config.
- `bash -n bin/hive` clean.
- 207/207 unit tests still pass (no TypeScript touched).

### How to roll out

`git pull && pnpm install && pnpm build` — no PM2 restart required.
`bin/hive` is sourced fresh on each invocation, so the version-fix
takes effect immediately.

### PR

- #27 — `feat/update-visibility`

---

## [1.3.3] — 2026-04-29

**Three orchestration fixes surfaced by the v1.3.2 end-to-end smoke
test.** All discovered live during the haiku smoke run; bundled per
house-md's review request.

### Bug #1 — PM2-managed runner silent on boot (already on branch as `03f2da8`)

`src/runner/index.ts` previously gated `main()` behind an
`isDirectInvocation` conditional (`import.meta.url ===
\`file://${process.argv[1]}\` || endsWith("runner/index.js")`). Under
PM2's launch path, the conditional evaluated false on some setups —
`main()` never ran. The runner appeared "online" in `pm2 list` (process
alive, idle) but produced zero log output and processed zero tasks.

**Fix.** Split the entry point. `src/runner/index.ts` is now a pure
library (exports `main` and helpers, no auto-execution). New
`src/runner/main.ts` is the PM2 entry — imports `main()` and runs it
unconditionally. `ecosystem.config.cjs` updated to point at
`dist/runner/main.js`. Tests still import from `index.js` without
triggering the daemon. Verified post-fix: PM2 boot writes the boot
banner to logs, polling loop runs, tasks process within 2s.

### Bug #2 — Orphan recovery didn't fire wake

When the runner restarted and discovered a task in `running` state
(orphaned by a previous runner exit), it marked the task `failed` and
wrote an events-log entry — but did not enqueue a wake. The owning
agent had no signal. PR 2b's "crash recovery" promise broke quietly
here.

**Fix.** `processOneTask` now calls `enqueueWake()` after marking the
orphan failed. The wake prompt's failure path (default: "decide whether
to retry, escalate, or abandon", or the agent's own
`on_failure_prompt` if set) drives the agent's next move. Test asserts
both the task-file flip and the wake-file appearance.

### Bug #3 — `kind=response` sender-side validation against the wrong registry

`sendToAgent` for `kind=response` called `lookupDelegation(taskId)` on
the SENDER's local registry. But the original delegation lives in the
DELEGATOR's registry (the recipient of the response), not the
responder's (the sender). A legitimate `kind=response` was rejected
as "stale task: no in-flight delegation found for taskId". Surfaced
when atlas tried to send the smoke-test haiku back to house-md.

**Fix.** Drop the sender-side lookup. The `taskId` requirement stays
(must be present for a response). Validation moves entirely to the
receiver via `routeInbound` (already correct). Matches the bot's
existing auto-reply path — it constructs responses with `parsed.taskId`
from the inbound message and never validates locally either.

### Tests

- 207/207 pass (204 prior + 3 new — orphan-wake assertion, kind=response
  smoke-test simulation, regression guards for receiver-side stale
  detection).
- Build clean.

### How to roll out

`git pull && pnpm install && pnpm build && pm2 restart all
--update-env && pm2 restart hive-runner --update-env && pm2 save`.
No config or migration changes.

### PR

- #26 — `fix/runner-pm2-entry-point` (bundling all three v1.3.3 fixes)

---

## [1.3.2] — 2026-04-29

**Fix: `EscalateToOwner` is no longer blocked during hivemind processing,
and now suppresses the bot's auto-reply for the rest of the turn.**
Eliminates the "agent-to-agent ping-pong while owner waits" failure
mode that the v1.2.x and v1.3.x architecture was supposed to prevent.

### Why

Today's PR #24 rollout discussion exposed a real failure mode. House-md
sent atlas a hivemind delegation needing owner authorization (fleet
restart). Atlas tried to call `EscalateToOwner` to surface the question
to #atlas — got blocked because `hivemindProcessingActive=true`. Atlas
fell back to a text reply, which auto-routed back to house-md as
`kind=response`, which spun house-md up to read "I'm asking the owner."
House-md's own response (also addressed to "Owner —") routed via
hivemind to atlas — same problem on the return trip. Three round-trips
happened in #hivemind before the owner pulled the cord; #atlas got
nothing.

The owner's framing nailed the principle: **"when you get blocked and
you need me, you should have to ask me before you go back and respond
to him."** Every hivemind text reply spins up the receiver. If the
receiver doesn't have the answer either (because the answer requires
the owner), the text exchange is pure waste.

### Two bugs, one fix

1. **`EscalateToOwner` had a wrong copy-pasted block.** The
   `hivemindProcessingActive` check made sense for `SendMessage` (would
   double-post to #hivemind if both the tool and the bot's auto-reply
   ran). It made NO sense for `EscalateToOwner` — that tool posts to
   the agent's OWN primary channel, not to #hivemind. No double-post
   risk, no loop. Removed.

2. **The bot's auto-reply ran even when the agent had escalated.**
   Even after EscalateToOwner sent its silent-absorb `kind=escalation`
   notice to the delegator, the bot still posted the agent's text
   reply as `kind=response`. The delegator's bot routed the kind=response
   as a request, fired runAgent, and the spin-up cycle began.

### Fix

- `markEscalationFired()` is called from inside `escalateToOwner()`.
- The bot's hivemind request handler reads `consumeEscalationFlag()`
  immediately after `runAgent` returns. If true, it skips both the
  text auto-reply and the per-error fallback posts. The original
  delegation stays pending in the registry. When the owner answers in
  the agent's primary channel, a fresh turn fires and THAT turn issues
  the actual `kind=response` back to the delegating agent.

Result: **one productive spin-up per side**, instead of multiple
wasted round-trips.

### Tool description updated

`EscalateToOwner` now documents the "end your turn after escalating"
contract explicitly, so future agent authors don't fall into the same
trap. Use cases broadened from "I'm blocked" to also include status
updates and decisions only the owner can make.

### Tests

- 203/203 pass (198 prior + 5 new). New tests verify the flag's
  read-and-clear semantics, independence from the registry, and the
  bot's intended suppression flow.
- Build clean.

### How to roll out

Same as v1.3.1: `pnpm build && pm2 restart all --update-env`. No
config changes, no migration. Pure code fix.

### PR

- #25 — `fix/escalate-suppress-auto-reply`

---

## [1.3.1] — 2026-04-29

**Autonomy v1 — PR 2b: wake mechanism + crash-resilient registry +
recent-task awareness.** Closes the autonomy loop. Agents now spin back
up when their long-running Codex/Claude/shell tasks finish. The Hive
no longer stalls on long-running work.

### Why

PR 2a (v1.3.0) shipped the runner that observes child processes to
terminal state. v1.3.1 makes the runner *useful*: when a task completes,
the owning agent is woken with a structured continuation prompt and
acts on it. Plus two additional safety mechanisms surfaced during the
PR 2a analysis:

- The in-memory delegation registry from PR #18 dies on `pm2 restart`.
  We watched that happen to house-md mid-conversation. **Persistence
  fixes it.**
- Without recent-task awareness in the system prompt, an agent that
  restarts mid-task is blind to its own pending work until a wake fires.
  **System-prompt injection fixes it.**

### Architecture (cross-process via file queue)

```
runner: terminal state on task → buildWakePrompt() → enqueueWake()
                                                      │
                                        agents/<name>/wake/<task_id>.json
                                                      │
bot:    polls wake/ every 5s → reads signal → agentExecutor(prompt, mode=wake)
                                                      │
                                              runAgent (silent — no auto-post)
                                                      │
                                        archive to wake/processed/
```

The `agentExecutor` callback gains a mode flag (`cron` | `wake`).
**cron** mode preserves today's behavior (auto-posts agent text reply
to its own channel for owner visibility). **wake** mode is silent —
the agent decides what surfaces, via SendMessage to other agents or
deliberate posts to its own channel. Finding (c) of the autonomy-v1
analysis.

### Added

- `src/runner/wake-prompt.ts` — pure builder for the wake prompt
  (success / failure / timeout banners; `on_complete_prompt` /
  `on_failure_prompt` with sensible defaults; output tail; reply-to
  linkage; silent-mode disclaimer).
- `src/runner/wake-queue.ts` — file-queue I/O. Atomic writes via
  temp-then-rename, archive-on-processed for at-least-once semantics.
- `src/discord/bot.ts` — wake-queue poller every 5s. Daily-memory line
  per wake (one-line summary at `agents/<name>/memory/<date>.md`).
- `src/runner/index.ts` — fires `enqueueWake()` on every terminal
  state transition.
- `src/tools/messaging.ts` — **persistent delegation registry**
  (finding a). Per-agent JSONL at `agents/<name>/state/delegations.jsonl`,
  24h TTL (up from 60min), replay on bot startup. Survives `pm2 restart`.
- `src/core/recent-tasks.ts` — system-prompt section builder
  (finding e, spec D1). Live tasks always included; terminal tasks only
  if finished in the last 24h. Capped at 10 entries.
- `src/core/prompt-builder.ts` — new "Recent Tasks" section between
  daily memories and safety rules.
- 35 new unit tests covering wake-prompt construction (every status
  branch + reply-to + output tail + missing log), wake-queue I/O,
  end-to-end runner→wake-file enqueue, recent-tasks recency rules,
  and the persistent registry's headline crash-recovery scenario:
  delegate → wipe in-memory → load from disk → response routes
  correctly (not a stale-task error).

### Changed

- `src/tools/cron.ts` — `AgentExecutor` signature gains optional `mode`
  arg. Backward-compatible with existing cron call sites.
- `DELEGATION_TTL_MS` — 60 minutes → 24 hours (finding a).

### How to roll out

1. `git pull && pnpm install && pnpm build`
2. `pm2 restart all` — agents pick up the new bot code (wake poller
   active, registry replay on startup, system prompt now shows tasks).
3. `pm2 start ecosystem.config.cjs --only hive-runner && pm2 save` if
   the runner isn't already up.
4. End-to-end smoke: `hive task launch --agent atlas --kind shell
   --cmd "echo hi" --on-complete "say done"` — within ~7s, atlas's
   session sees the wake prompt and acts. Daily memory file gains a
   `[wake]` line.

### PR

- #24 — `feat/autonomy-v1-wake`

---

## [1.3.0] — 2026-04-29

Autonomy v1 — PR 2a: task runner foundation. Observable-only release. The
`hive-runner` daemon picks up `pending` tasks written by `hive task launch`,
spawns the child process, captures stdout/stderr to a log file, enforces
per-kind timeouts, and writes the terminal status back to the task file.
Auto-wake on completion (the `agentExecutor` callback into the owning agent)
lands in **v1.3.1 / PR 2b**.

### Why

Per the spec at `agents/house-md/specs/hive-autonomy-v1.md`: the Hive stalls
on long-running work today. An agent fires off a Codex/Claude Code task in
tmux, ends its turn, and there is no listener for completion. v1.3.0 ships
the lifecycle plumbing; v1.3.1 closes the loop by waking the agent when the
task finishes.

### Added

- `src/runner/state-machine.ts` — pure lifecycle transitions
  (`pending` → `running` → `done`/`failed`/`timeout`/`cancelled`). Locked
  per-kind timeouts: codex 90m, claude 30m, shell 10m. Tested in isolation.
- `src/runner/task-file.ts` — read/write per-agent task files at
  `agents/<name>/tasks/<task_id>.md` with YAML frontmatter. Lazy-creates
  the `tasks/` dir on first use. `task_id` format: `t_YYYY-MM-DD_<agent>_<rand>`.
- `src/runner/spawner.ts` — `child_process.spawn` based runner internals.
  No tmux dependency (per finding (d) of the orchestration analysis).
  Watchdog timer enforces per-kind timeout via SIGTERM → SIGKILL grace.
  Injectable for tests.
- `src/runner/events-log.ts` — JSONL events log at `data/runner-events.log`.
  Visible record of every state change for post-mortem debugging.
- `src/runner/index.ts` — daemon entry. Polls every agent's `tasks/` dir
  every 2 seconds (more reliable than `fs.watch` cross-platform). Marks
  orphaned `running` tasks as failed on boot until PR 2b's proper crash
  recovery lands.
- `src/cli/task-launch.ts` — implementation of `hive task launch`. Writes
  a `pending` task file and prints the `task_id` on stdout.
- `bin/hive task launch ...` — bash dispatcher routing to the compiled CLI.
  Supports `--reply-to <agent>:<task_id>` (finding (b)) so PR 2b can wake
  the agent with a structured continuation that knows which inbound
  hivemind delegation to respond to.
- `ecosystem.config.cjs` — PM2 entry registering `hive-runner` as a
  long-running, single-instance daemon with autorestart + 300MB
  memory cap.
- 36 new unit tests (143 total) covering the state machine, task file
  round-tripping, spawner timeout/exit/cancel paths, events log, and the
  `processOneTask` discovery → mark-running flow.

### Out of scope (lands in v1.3.1 / PR 2b)

- Auto-wake on task completion via the `agentExecutor` callback.
- Persistent delegation registry (finding (a) — currently in-memory with
  60-min TTL; will become per-agent JSONL with 24h TTL).
- Split `agentExecutor` so cron mode posts to the agent's channel and
  wake mode is silent (finding (c)).
- Recent-task injection into agent system prompts at session start
  (finding (e), spec D1).
- Daily-memory wake-event line on every agent wake.

### How to roll out

1. `git pull && pnpm install && pnpm build`
2. `pm2 start ecosystem.config.cjs --only hive-runner && pm2 save`
3. Smoke: `hive task launch --agent atlas --kind shell --cmd "echo hi"`
4. Watch: `tail -f data/runner-events.log`. Within ~2 seconds you should
   see `discovered` → `spawned` → `exit` events; the task file flips to
   `status: done`.

### PR

- #22 — `feat/autonomy-v1-runner`

---

## [1.2.2] — 2026-04-29

**Critical safety: `git pull` and `hive update` can no longer delete your
agents.** Two-file config layout. Pure additive change — backward-compatible
with every existing Hive installation.

### Why

Today, `config/config.yaml` is committed AND modified locally with each
operator's agent set. Any of these wipes the agent set:

- `git checkout config/config.yaml` (after a stray edit elsewhere)
- `git reset --hard` (to undo unrelated changes)
- A `git pull` whose upstream `config.yaml` change conflicts with local
  modifications and is "resolved" by taking upstream

The owner correctly flagged that as the most critical risk to handle
before more `config.yaml`-touching code lands.

### Solution: overlay layout

- **`config/config.yaml`** — committed. Platform settings (model, codex,
  safety) + canonical seed agents (`house-md` ships with every Hive).
- **`config/agents.local.yaml`** — **gitignored**. Your actual agents.
  Never tracked, never pulled, never touched by any git operation.
- **`config/agents.local.example.yaml`** — committed template.

The loader merges them at boot. Local agents override committed on key
conflict; committed agents not redefined locally are preserved (so
`house-md` always comes through).

### Backward compatibility

Pure additive — if `agents.local.yaml` doesn't exist, the loader behaves
exactly as before (reads agents from `config.yaml`). **No existing
installation breaks on upgrade.** Operators opt in at their own pace by
running:

```
hive config migrate-agents
```

That command:
1. Backs up `config/config.yaml` to `config/config.yaml.backup-<timestamp>`.
2. Writes every agent currently in `config.yaml` to `config/agents.local.yaml`.
3. Prints next-steps for optionally cleaning up the committed file.

The migration is safe to re-run only if `agents.local.yaml` does not yet
exist (refuses to overwrite — gives an explicit move-aside instruction).

### Failure modes — loud, never silent

A malformed `agents.local.yaml` (bad YAML, non-mapping at top level,
array instead of object) raises a clear error at boot. Silent drop would
lose agents on the next restart with no signal — explicitly avoided.

### Verification

End-to-end smoke run before push:

1. Created a fixture with 3 agents in `config.yaml`.
2. Ran `hive config migrate-agents` — agents.local.yaml written, backup created.
3. **Wiped `config.yaml` down to house-md only** (simulated `git checkout config/config.yaml`).
4. Loader still returned all 3 agents from the overlay. PASS.

### Added

- `src/core/config-overlay.ts` — `mergeAgents` + `loadConfigWithOverlay`.
  Pure / injectable / unit-tested.
- `src/cli/config-migrate-agents.ts` — the migration script.
- `bin/hive config migrate-agents` — bash dispatcher to the migrator.
- `bin/hive config` (without subcommand) shows whether the overlay is
  active and points at the migration if not.
- `config/agents.local.example.yaml` — template doc for new operators.
- 19 new unit tests covering merge correctness, override semantics, the
  "house-md must survive" headline case, malformed-input rejection,
  legacy-mode backward compat, and immutability of inputs.

### Changed

- `src/core/agent.ts::loadConfig` now delegates to the overlay loader.
  Boot logs `[config] Loaded N agent(s) — committed config + local overlay`
  when the overlay is active.

### `.gitignore`

Added: `config/agents.local.yaml`, `config/config.yaml.backup-*`.

---

## [1.2.1] — 2026-04-29

Tool-level fix for hivemind message truncation. When a hivemind message body
exceeds **1900 chars** (matching the existing chunk-size used elsewhere for
owner-facing channels), the SendMessage tool (and the bot's auto-reply path)
write the full content to `shared/exchange/` and rewrite the outbound message
to a short imperative stub plus an `[ATTACH:]` marker. The stub explicitly
instructs the receiving agent to use its `Read` tool on the file path before
responding. Single Discord message, full content delivered, no chunking, no
dropped tail.

**Scope:** inter-agent (hivemind) only. Owner-facing channel replies are
unchanged — they still chunk into multiple Discord messages via
`splitMessage`, which is the right UX for owner conversations.

### Why

The `splitMessage` helper that handles owner-channel chunking is broken for
hivemind: only the first chunk carries the `**[from → to]**` header, so
subsequent chunks fail the receiver's pattern match and are silently dropped.
Discovered today when house-md's reply to atlas was truncated mid-sentence.

### Added

- `maybeOffloadLargeMessage(from, to, body)` in `src/tools/messaging.ts`.
  Detects bodies over `HIVEMIND_OFFLOAD_THRESHOLD` (1900 chars), writes to
  `shared/exchange/<sender>-<receiver>-<slug>-<YYYYMMDD>.md`, returns a
  short imperative stub with an `[ATTACH:]` marker. The stub tells the
  receiving agent it MUST use its `Read` tool on the absolute path
  before responding — the stub is not the full message.
- `deriveSlug(message)` — kebab-case slug derivation from the first
  non-empty line of a message; capped at 40 chars.
- 12 new unit tests covering slug derivation, threshold behavior, file
  layout, same-day disambiguation, stub size guarantees, and the
  imperative wording of the stub instructions.

### Changed

- `sendToAgent` (the SendMessage backend) auto-offloads oversized bodies
  before formatting the wire message.
- The bot's hivemind request → response auto-reply path applies the same
  offload, so agents whose generated replies exceed the limit no longer
  drop the tail of the message.

### Notes

- Behavior is automatic and durable across the Hive — no per-agent
  AGENTS.md edits required when shipping to other employees' machines.
- Same-day same-topic offloads disambiguate via a `-2`, `-3` counter
  suffix on the filename.
- Tests use injectable fs operations; no disk I/O during the test suite.

### PR

- #21 — `feat/auto-offload-large-hivemind`

---

## [1.2.0] — 2026-04-28

Hivemind orchestration overhaul. Replaces the brittle 5-minute timing
heuristic with deterministic message routing, adds an escalation tool for
delegated agents, and documents the inter-agent file-exchange convention.

### Added

- **Explicit message kinds on every hivemind message.** `SendMessage` now
  accepts `kind: "delegation" | "response" | "escalation" | "query"` plus an
  optional `task_id`. Wire format gained an inline marker:
  `**[from → to]** \`kind:taskId\`\n<body>`. Messages without the marker are
  treated as legacy delegations for backwards compatibility.
- **Persistent (in-memory) delegation registry.** Tracks every in-flight
  delegation by task id with a 60-minute TTL. Responses must reference a
  registered task id; unmatched responses surface as a visible stale-task
  error in `#hivemind` instead of silently routing as fresh requests.
- **`EscalateToOwner` tool.** Lets a delegated agent post a clarifying
  question to its own user-facing channel (with a 🆘 prefix) and notify
  the delegating agent over hivemind that work is paused — without
  breaking out of the delegation context.
- **`shared/exchange/` convention** for inter-agent file passing. Directory
  is tracked (with README); contents are gitignored. Naming pattern:
  `<sender>-<receiver>-<task-slug>-<YYYYMMDD>.md`.
- **`registerPrimaryChannel`** helper so the runner-side primitives can
  reach an agent's user-facing channel by name.
- **30 new unit tests** in `src/tools/messaging.test.ts` covering parsing,
  registry lifecycle, the delegation→response cycle, escalation routing,
  and the stale-task surfacing path.

### Changed

- `src/discord/bot.ts` replaces the inline `isHivemindResponsePending`
  check with the explicit `routeInbound` decision tree. Outgoing replies
  now carry the inbound `task_id` automatically.
- `templates/coding-agent/AGENTS.md` and `templates/generalist/AGENTS.md`
  document the new tools and the file-exchange convention.
- `shared/GLOBAL-TOOLS.md` documents `kind` and `EscalateToOwner`.

### Removed

- The 5-minute `pendingHivemindTargets` window and `isHivemindResponsePending`
  function. Routing is now driven by explicit context, not timing.

### Notes

- Backwards compatible: agents that emit legacy messages without the
  marker continue to be routed as delegations. New agents and the
  upgraded bot emit the marker on every send.
- Known limitation: the delegation registry is in-memory. A `pm2 restart`
  during an in-flight delegation drops the entry, and a response arriving
  after restart will surface as stale. Will be persisted in a follow-up
  alongside autonomy-v1.

### PR

- #18 — `feat/hive-orchestration-fixes`

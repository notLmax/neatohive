# TASKS.md — House MD

## Active Tasks

| # | Task | Priority | Status | Notes |
|---|------|----------|--------|-------|
| 1 | v1.4.x backlog: silent runner death investigation | Low | Logged 2026-05-06 | Runner restarted at 21:45:57.466Z after ~2hr gap with no graceful shutdown event logged. Orphan-recovery worked end-to-end. Investigate pattern after v1.5.0 ships. Glados surfaced. |
| 2 | v1.4.x polish: pm2 startOrReload strict-no-op when already-online | Low | Logged 2026-05-06 | v1.4.9 smoke surfaced: hive bootstrap on already-online process does benign reload (pid change). Outcome-idempotent but not strict no-op. v1.5.x or later polish. |
| 3 | v1.5.0 A.4 fold-in: provision script `ensure_project_link()` false-positive fix | Low | Logged 2026-05-06 | `vercel git connect` exits non-zero on idempotent already-connected case; script treats as failure. ~5-line edit. Folded into A.4 brief by glados. |

## Completed Tasks

| # | Task | Completed | Notes |
|---|------|-----------|-------|

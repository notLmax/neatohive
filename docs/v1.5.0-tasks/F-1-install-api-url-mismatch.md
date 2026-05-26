# v1.5.0 F-1 — Install metadata URL mismatch fix

**Status:** LOCKED — raymond-holt dispatches Bob via SendMessage immediately after this spec lands on main.
**Project:** v1.5.0-website-installer-dashboard (hygiene follow-up)
**Predecessors:** J.1.0.6 merged (967f027), eacf2fb critical-rules update merged. v1.5.0 SHIPPED but installer is broken because metadata URL is 404.
**Successor:** raymond-holt re-runs release ceremony (release.sh + release-publish.sh + manual public/ ceremony + vercel CLI deploy) after this PR merges.

---

## Background — the defect

`install.sh` ships in v1.5.0 with `DEFAULT_API_URL="https://neato-hive-site.vercel.app/api/current"`. `bin/hive`'s `update` command shares the same default at line 529.

But `release-publish.sh` writes the metadata JSON to `releases/current.json` on the site repo. Two paths that should be the same path are not. The live site responds with:

| URL | Status |
|---|---|
| `https://neato-hive-site.vercel.app/api/current` | **404** |
| `https://neato-hive-site.vercel.app/releases/current.json` | **200** (contains correct JSON envelope) |

Result: bare-curl-bash install fails with "release metadata download succeeded but the body was empty" or 404. `hive update` would also 404 on any existing user (but no users exist yet — only Daniel's dev clone).

J.1 smoke test ran against local file fixtures (`--api-url=file://...`), not the live URL, so this slipped through.

---

## Decision

**Update install.sh + bin/hive to point at `releases/current.json` (where the publishing script actually writes).** No site-repo changes. No version bump. Republish v1.5.0 with corrected install.sh + bin/hive embedded. Authorized by Daniel 2026-05-11: "it's not live to anyone yet so we can fix it."

---

## Workflow lock

**Target branch: `main`.** This is framework-level hygiene; it is NOT part of the chat-mirror feature scope. Bob branches from `main`, leaf branch `fix/v1.5.0-F-1-install-api-url-mismatch`, PR base = `main`.

**DO NOT TARGET `feat/dashboard-chat-mirror`.** That branch is for chat-mirror leaves only.

---

## Diff lock — 2 paths exactly

1. `install.sh` — DEFAULT_API_URL string + help-text mention (2 line edits)
2. `bin/hive` — line 529 helper function default URL (1 line edit)

**NO other paths.** No tests change (no install.sh test fixtures reference the URL). No docs change (the `docs/v1.5.0-tasks/*.md` historical specs intentionally preserve the original-design URL for posterity — leave them alone). No spec or test additions.

---

## A. Pre-flight halts (HALT and ping raymond-holt if ANY fail)

```bash
# 1. On main, clean working tree (whitelist exceptions: agents/, data/, docs/TASK.md, pnpm-lock.yaml, skills/, dashboard/node_modules/)
git rev-parse --abbrev-ref HEAD              # Expected: main
git fetch origin && git rev-parse origin/main # Expected: eacf2fb or newer

# 2. Confirm exact URL strings still match what F-1 expects to find
grep -nE 'DEFAULT_API_URL="https://neato-hive-site\.vercel\.app/api/current"' install.sh
# Expected: 1 match at line 36

grep -nE 'echo "\${HIVE_RELEASES_API:-https://neato-hive-site\.vercel\.app/api/current}"' bin/hive
# Expected: 1 match at line 529

grep -nE 'Default: \$HIVE_RELEASES_API or https://neato-hive-site\.vercel\.app/api/current' install.sh
# Expected: 1 match at line 86

# 3. Confirm no other code-path references (docs do NOT count for this gate)
grep -rEn 'api/current' bin/ src/ scripts/ install.sh 2>/dev/null | wc -l
# Expected: exactly 3 matches (all 3 to fix; no other code-path references — install.sh line 46 references DEFAULT_API_URL variable, not the literal string).

# 4. Confirm the destination URL is live
curl -sIL -o /dev/null -w "%{http_code}\n" https://neato-hive-site.vercel.app/releases/current.json
# Expected: 200

# 5. bash syntax checks pre-edit
bash -n install.sh && echo "install.sh syntax pre-edit ✓"
bash -n bin/hive && echo "bin/hive syntax pre-edit ✓"
```

**HALT and ping raymond-holt** if any check fails. Your 9-for-9 L8 discipline is the standard.

---

## A.1 — install.sh edits

**File:** `install.sh`

**Edit 1 — line 36 (DEFAULT_API_URL):**

```diff
-DEFAULT_API_URL="https://neato-hive-site.vercel.app/api/current"
+DEFAULT_API_URL="https://neato-hive-site.vercel.app/releases/current.json"
```

**Edit 2 — line 86 (help text):**

```diff
-                           Default: $HIVE_RELEASES_API or https://neato-hive-site.vercel.app/api/current.
+                           Default: $HIVE_RELEASES_API or https://neato-hive-site.vercel.app/releases/current.json.
```

No other changes to install.sh. Lines 46 (`API_URL="${HIVE_RELEASES_API:-$DEFAULT_API_URL}"`), 195 (`API_URL="${1#*=}"`), 218 (validation), 627 (curl invocation), 878 (print step) all consume the variable and need no edits.

---

## A.2 — bin/hive edit

**File:** `bin/hive`

**Edit 1 — line 529:**

```diff
-  echo "${HIVE_RELEASES_API:-https://neato-hive-site.vercel.app/api/current}"
+  echo "${HIVE_RELEASES_API:-https://neato-hive-site.vercel.app/releases/current.json}"
```

No other changes to bin/hive.

---

## B. Acceptance gates

### B.1 — `bash -n` clean post-edit

```bash
bash -n install.sh && echo "install.sh ✓"
bash -n bin/hive && echo "bin/hive ✓"
```

### B.2 — No remaining `/api/current` references in code paths

```bash
grep -rEn 'api/current' bin/ src/ scripts/ install.sh 2>/dev/null
# Expected: empty output (all code-path occurrences eliminated)
```

(Docs under `docs/v1.5.0-tasks/` MAY still contain references — those are historical and intentional; do NOT edit them.)

### B.3 — Help text reflects new URL

```bash
bash install.sh --help 2>&1 | grep -E 'releases/current\.json' | head -3
# Expected: 1 match showing the new URL in the help output
```

### B.4 — `bin/hive` `--api-url` resolution test

```bash
HIVE_RELEASES_API='' bash -c 'source <(head -550 bin/hive) 2>/dev/null; resolve_api_url 2>/dev/null || true'
# Expected: this is informational only; if the source-and-call pattern doesn't work in your environment, document it. The grep gate (B.2) is authoritative.
```

(B.4 may be skipped if your shell harness doesn't permit partial-source. The B.2 grep is the binding test.)

### B.5 — Diff lock = 2 paths exactly

```bash
git diff --stat main...fix/v1.5.0-F-1-install-api-url-mismatch
# Expected: 2 files (install.sh, bin/hive). Total ~6 line edits.
```

### B.6 — Live-URL smoke (informational; runs against current production)

```bash
curl -fsSL https://neato-hive-site.vercel.app/releases/current.json | jq -r .version
# Expected: "1.5.0" (or whatever version is currently published)
```

This confirms the destination URL works. Note: the LIVE install.sh on the website still has the old URL until raymond-holt re-runs the release ceremony post-merge. B.6 just confirms the destination is reachable.

### B.7 — No edits outside diff-lock

```bash
git diff --stat main...fix/v1.5.0-F-1-install-api-url-mismatch -- ':!install.sh' ':!bin/hive'
# Expected: empty (no other paths modified)
```

---

## C. Hard NO list

- DO NOT modify `docs/v1.5.0-tasks/*.md` (historical specs — preserve original-design URLs)
- DO NOT modify `scripts/release-publish.sh` (already writes to the correct path — see lines 175, 247, 251 which all reference `/releases/current.json`)
- DO NOT modify any test fixture (no tests reference these URLs)
- DO NOT add new prereqs, new flags, new features
- DO NOT bump version number — Daniel's "it's not live to anyone yet" authorizes in-place republish of v1.5.0
- DO NOT MERGE — raymond-holt merges after review

---

## D. DONE block format

```text
PR URL: <gh url>
Branch: fix/v1.5.0-F-1-install-api-url-mismatch (targets main)
Diff: 2 paths (install.sh + bin/hive)

Pre-flight outputs:
  1. HEAD: <sha — main tip>
  2. exact strings present at lines 36, 86 (install.sh) and 529 (bin/hive): ✓
  3. /api/current code-path occurrences pre-edit: 3 found (all 3 to fix; no composed fallback exists)
  4. https://neato-hive-site.vercel.app/releases/current.json → 200
  5. bash -n syntax pre-edit: ✓

Tooling check (post-edit):
  bash -n install.sh: ✓
  bash -n bin/hive: ✓

Gates:
  B.1 syntax: ✓
  B.2 no api/current in code paths: ✓ (0 hits)
  B.3 help text shows releases/current.json: ✓
  B.5 diff-lock = 2 paths: ✓
  B.6 destination URL live: 200, version <x>
  B.7 no out-of-scope edits: ✓

Worker scope attestations:
  - No docs/v1.5.0-tasks/ edits
  - No scripts/ edits
  - No test/ edits
  - Diff is 2 paths exactly: install.sh + bin/hive
  - Total line-edits: ~6 (3 in install.sh, ~3 in bin/hive depending on context)
```

---

## E. Commit message

```
fix(v1.5.0): F-1 metadata URL mismatch — install.sh + bin/hive

install.sh DEFAULT_API_URL and bin/hive update-command default URL
both pointed at https://neato-hive-site.vercel.app/api/current.
release-publish.sh writes to /releases/current.json. The two paths
were never reconciled; bare-curl-bash install 404s on metadata fetch.

This commit updates both consumers to point at /releases/current.json
where the publishing script actually writes. Authorized by Daniel
2026-05-11: "it's not live to anyone yet so we can fix it."

Post-merge: raymond-holt re-runs release.sh 1.5.0 + release-publish.sh
1.5.0 + manual public/ ceremony + vercel CLI deploy to republish v1.5.0
with the corrected install.sh + bin/hive embedded in the tarball.

No version bump (in-place republish). No tests changed (no install
test fixture references these URLs). Historical specs in
docs/v1.5.0-tasks/ preserve original-design URLs intentionally.
```

PR title: `fix(v1.5.0): F-1 install + hive update metadata URL mismatch`

PR body: pre-flight outputs verbatim, B.1-B.7 outputs verbatim, the rationale paragraph from above, diff-stat confirmation.

---

## F. on-complete prompt

`Bob completed F-1 (install metadata URL fix). Review PR, verify diff-lock (2 paths exact, install.sh + bin/hive, no docs/test edits) and B.x gates, merge to main if clean, then re-run release ceremony.`

---

## G. Release ceremony (raymond-holt runs, post-merge)

For raymond-holt's reference; not part of Bob's leaf:

1. `cd ~/projects/neato-hive && git checkout main && git pull`
2. `./scripts/release.sh 1.5.0` — rebuilds tarball with new install.sh + bin/hive
3. `./scripts/release-publish.sh 1.5.0` — pushes tarball + new current.json (with new SHA) to site repo
4. Manual public/ ceremony (since F-2 is not yet fixed): clone site repo, move files into `public/`, `vercel --prod --yes` from the site repo clone
5. Smoke: `curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash` on a fresh machine — confirm bare-curl-bash works end-to-end
6. Update raymond-holt's project doc + daily memory with the F-1 outcome

End of spec.

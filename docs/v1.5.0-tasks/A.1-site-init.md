# v1.5.0 A.1 — Site Repo Init + Plain HTML Pages

**Status:** LOCKED — house-md greenlit 2026-05-06, dispatch ready

> Note: glados drafted this spec in `shared/exchange/glados-house-md-v1.5.0-A.1-site-init-spec-draft-20260506.md`. House-md greenlit with two minor tweaks (use `gh repo clone` instead of SSH; soften the `rm -rf` to remote-URL check) and committed it to framework main directly so dispatch could fire without further round-trips.
**Project:** v1.5.0-website-installer-dashboard
**Phase:** A — Site repo + Cloud Run backend skeleton
**Leaf:** A.1 (1 of 6 in Phase A)
**Author:** glados (per project-lead role; this is the first glados-authored leaf in v1.5.0)
**Executor:** bob-the-builder (via codex strict per standing directive)
**Predecessor:** A.0 ✅ merged 2026-05-06 (PR #44, squash `936ca6e` on framework `main`)
**Successor:** A.2 — Cloud Run backend service skeleton

---

## Goal

Ship the static frontend baseline of `https://neato-hive-site.vercel.app` to the SITE repo `Daniel-Neato/neato-hive-site`. Four HTML pages + plain-CSS aesthetic + ASCII bee wordmark + repo README. Functional even before A.4 wires push-to-deploy via the Vercel GitHub App.

---

## Scope

### In (commits to SITE repo `Daniel-Neato/neato-hive-site`, not framework repo)

- `public/index.html` — landing page
- `public/install.html` — step-by-step install guide (placeholder copy for v1.5.0; actual install commands land when B/C/F close)
- `public/changelog.html` — placeholder for release notes pattern (structure only; actual v1.5.0 entry comes at J.2)
- `public/styles.css` — plain HTML, classic hyperlinks, sqlite.org / openbsd.org aesthetic
- ASCII bee wordmark (per owner directive — lean toward bee over "HIVE" text, more personality)
- `README.md` at repo root describing repo purpose
- Vercel framework preset confirmed/set to "Other" (static — no build step)

### In (optional, glados-decided YES — commits to FRAMEWORK repo)

- Snapshot at `templates/site-skeleton/` mirroring the site repo's `public/*` + README. Reason: re-provisioning future skill-shop static sites or recovering from accidental site-repo wipe is much easier when the canonical state lives in the framework repo. Cheap insurance.

### Out

- Vercel GitHub App installation (owner-side, blocks A.4 only — see Owner-side TODOs in project file)
- `current.json` API endpoint or any backend logic (A.2-A.5)
- Tarball release UI (Phase B)
- Marketing copy beyond placeholder (owner doesn't want marketing fluff per `shared/NEATO-NARRATIVE.md`)

---

## Pre-flights (capture all outputs for PR body)

1. `git ls-remote https://github.com/Daniel-Neato/neato-hive-site` — confirm seeded `main` branch exists with the README + .gitignore from A.0.
2. `vercel projects ls --token=<from-1P-or-cli-auth>` — confirm `neato-hive-site` project exists with id `prj_W6rhgODPR0B1Dq5nOcRhl2NTSvzj`.
3. `vercel project inspect neato-hive-site` (or dashboard) — confirm framework preset. If not "Other", set it before any deploy work.
4. Confirm git auth — Bob uses the machine-level glados-daniel-lorena GitHub PAT (same as atlas for lore). `gh auth status` should show authenticated.

If pre-flight #2 or #3 reveals state inconsistent with what A.0 reported (PR #44 commit `936ca6e`), **HALT and ping glados** — no silent workarounds (carrying forward the C.2-v1 lesson from lore).

---

## Deliverables

### Site repo (`Daniel-Neato/neato-hive-site`)

Branch: `feat/A.1-site-init`
PR title: `feat(site): A.1 plain HTML pages + ASCII bee + plain stylesheet`

Files:
- `public/index.html` — single-page landing. Sections: brief intro to Hive, "What it does" (3-4 bullets), "Get started" CTA linking to `/install.html`, "Changelog" link to `/changelog.html`. ASCII bee wordmark at top.
- `public/install.html` — step-by-step install. Placeholder steps: (1) "Download the latest release [from changelog]", (2) "Run the installer script (one-line curl)" — actual command stays as `<placeholder — finalized in B/F>`, (3) "Open the dashboard at localhost:7777." Owner directive lean: copy-paste-friendly, terminal-aesthetic.
- `public/changelog.html` — placeholder structure. One `<section>` per version. v1.5.0 entry exists with title + date + bullet list "release notes coming at J.2". Future versions append above v1.5.0.
- `public/styles.css` — plain HTML aesthetic. Classic blue underlined links. Black serif body text on white. Monospace code blocks. No JS. No CSS framework. Sqlite.org / openbsd.org / nginx.org/en/download.html as references.
- `README.md` — what the repo is, that it's NOT the framework, link to framework repo (`Daniel-Neato/neato-hive`), how to run locally (`cd public && python3 -m http.server`), how to deploy (auto via Vercel GitHub App once installed; manual via `vercel deploy --prod` until then).

ASCII bee wordmark — placement and styling at Bob's discretion, but the bee should be visually centered or top-of-page. Examples (Bob picks one or designs his own):

```
  \   /
   \_/
    *
   ===
   /||\
  /_||_\
```

Or a simpler one-line variant:

```
~ \>=B=</ ~
```

Owner pref unknown beyond "ASCII bee, lean toward bee over HIVE text, more personality." Bob picks one and it lands. Owner can request a swap later as a one-line PR.

### Framework repo (`Daniel-Neato/neato-hive`)

Branch: `feat/v1.5.0-A.1-site-skeleton-snapshot`
PR title: `feat(templates): v1.5.0 A.1 site-skeleton snapshot for re-provisioning`

Files:
- `templates/site-skeleton/public/index.html` (mirror of site repo)
- `templates/site-skeleton/public/install.html`
- `templates/site-skeleton/public/changelog.html`
- `templates/site-skeleton/public/styles.css`
- `templates/site-skeleton/README.md` (mirror)
- `templates/site-skeleton/META.md` — describes the snapshot's purpose, the source repo, and how to re-provision (run `scripts/provision-v1.5.0.sh` then sync `templates/site-skeleton/*` into the new site repo).

Both PRs ship in the same Bob session. Bob commits to both repos sequentially (site repo first since framework snapshot mirrors it).

---

## Test plan

### Manual

- After site-repo PR is open (NOT merged), Bob runs `vercel deploy` from the site repo locally (manual deploy — Vercel GitHub App not installed yet). Verify all 4 pages render at the resulting preview URL.
- Click every link in every page — confirm internal nav works, no 404s.
- View source on each page — confirm ASCII bee renders correctly (no entity-encoding mishaps).
- Resize browser window — confirm pages don't break at narrow widths (basic responsive sanity).

### Automated

- `npx html-validate public/*.html` — should pass clean (or skip if Bob doesn't have it; not a hard gate).
- shellcheck / no shell scripts in this leaf — N/A.

### Acceptance

- All 4 HTML files exist in site repo's `public/`
- `styles.css` exists in `public/`
- README.md exists at site repo root
- ASCII bee renders (visible in browser source + DOM)
- Vercel framework preset is "Other"
- Manual `vercel deploy` produces a working preview URL with all 4 pages reachable
- Framework repo has `templates/site-skeleton/` snapshot (5 files matching site repo's content + META.md)

---

## DON'T HALF-SHIP rule

A.1 ships as TWO PRs from one Bob session, in this order:
1. Site-repo PR (the actual website code)
2. Framework-repo PR (the template snapshot mirroring site-repo state at the same SHA reference)

If Bob can't ship both cleanly in one session, halt and ping glados. Don't ship the site-repo PR alone and leave the snapshot for "later" — that creates drift.

---

## What Bob does NOT do

- Does NOT install the Vercel GitHub App (owner-side, A.4-blocker)
- Does NOT merge either PR (glados merges)
- Does NOT add JavaScript or any build step (plain HTML/CSS only)
- Does NOT add any tarball, current.json, /api/ paths (those are A.2-A.5)
- Does NOT add marketing copy beyond placeholder text

---

## On-complete prompt (Bob-aimed)

Per the C.3/D.1 lesson — supervisor-aimed prompts misroute via `--agent bob-the-builder` wake. So the on-complete prompt is Bob-aimed:

> "Your A.1 codex session exited. Verify before declaring DONE: (a) two PRs open — site-repo `feat(site): A.1 plain HTML pages + ASCII bee + plain stylesheet`, framework-repo `feat(templates): v1.5.0 A.1 site-skeleton snapshot for re-provisioning`; (b) site-repo PR contains exactly the 6 files listed in spec §Deliverables; (c) framework-repo PR contains exactly the 6 files listed in spec §Deliverables (snapshot + META.md); (d) all 4 pre-flight outputs in PR body; (e) `vercel deploy` preview URL captured in DONE block; (f) ASCII bee rendered correctly in screenshot or DOM-quote of index.html. If your DONE block exceeds 1900 chars, offload to `shared/exchange/bob-the-builder-glados-A.1-done-pr-N+M-...-20260506.md` and reference via [ATTACH:]. Then ping glados via SendMessage with `kind=delegation` (NOT `kind=response` — task-id aging issue carried forward from lore D-leaves) and a brief 'A.1 DONE — site PR #N + framework PR #M' note."

---

## Worker dispatch shape (for house-md to issue, since cross-agent launch gate v1.4.7.1 blocks glados from launching `--agent bob-the-builder`)

```bash
hive task launch \
  --agent bob-the-builder \
  --kind codex \
  --timeout 60 \
  --on-complete "<the on-complete prompt above, with proper escaping>" \
  --cmd "cd ~/projects && rm -rf neato-hive-site || true && git clone git@github.com:Daniel-Neato/neato-hive-site.git && cd ~/neato-hive && codex exec --yolo 'Read /Users/glados/neato-hive/shared/exchange/glados-house-md-v1.5.0-A.1-site-init-spec-draft-20260506.md (after review-greenlight, this will be at docs/v1.5.0-tasks/A.1-site-init.md on framework main). Implement per spec. Branch ~/projects/neato-hive-site as feat/A.1-site-init. Branch framework as feat/v1.5.0-A.1-site-skeleton-snapshot. Ship both PRs (site-repo first). DO NOT MERGE. Print DONE block per spec.'"
```

(House-md substitutes the on-complete prompt and confirms branch + cmd. I'll commit the spec to framework `main` at `docs/v1.5.0-tasks/A.1-site-init.md` once you greenlight the draft.)

---

## Open questions for house-md review

1. **Snapshot under `templates/site-skeleton/` — keep or drop?** I'm recommending keep for re-provisioning insurance, but it doubles the leaf's surface (two PRs not one). If you'd rather A.1 be smaller and we add the snapshot later as its own leaf, push back.
2. **Vercel framework preset** — confirmed "Other" / static? If A.0's provisioning script already set this, pre-flight #3 just verifies. If not, A.1 sets it as part of the leaf.
3. **ASCII bee aesthetic** — Bob picks (designer's discretion within the constraint). OK or should I include a specific example to lock in?
4. **Spec landing in framework repo** — once you greenlight, I commit to `docs/v1.5.0-tasks/A.1-site-init.md` on framework main, then dispatch references that path. OK?

Ping back with answers + greenlight (or counter-spec). Once locked, I commit + you dispatch via the launch command.

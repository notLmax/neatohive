#!/usr/bin/env bash

set -euo pipefail

GITHUB_OWNER="${GITHUB_OWNER:-Daniel-Neato}"
REPO_NAME="${REPO_NAME:-neato-hive-site}"
REPO_SLUG="${GITHUB_OWNER}/${REPO_NAME}"
REPO_URL="https://github.com/${REPO_SLUG}"
REPO_GIT_URL="${REPO_URL}.git"
TMP_DIR="${TMP_DIR:-/tmp/${REPO_NAME}}"
VERCEL_PROJECT_NAME="${VERCEL_PROJECT_NAME:-neato-hive-site}"
VERCEL_SCOPE="${VERCEL_SCOPE:-}"

log() {
  printf '[provision-v1.5.0] %s\n' "$*"
}

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || {
      printf 'Missing required command: %s\n' "$cmd" >&2
      exit 1
    }
  done
}

run_vercel() {
  if [[ -n "$VERCEL_SCOPE" ]]; then
    vercel --scope "$VERCEL_SCOPE" "$@"
  else
    vercel "$@"
  fi
}

repo_exists() {
  gh repo view "$REPO_SLUG" >/dev/null 2>&1
}

ensure_repo() {
  if repo_exists; then
    log "GitHub repo already exists: ${REPO_SLUG}"
    return
  fi

  log "Creating private GitHub repo: ${REPO_SLUG}"
  gh repo create "$REPO_SLUG" \
    --private \
    --add-readme \
    --description "Website distribution repo for Neato Hive" \
    >/dev/null
}

fresh_clone() {
  rm -rf "$TMP_DIR"
  log "Cloning ${REPO_SLUG} into ${TMP_DIR}"
  gh repo clone "$REPO_SLUG" "$TMP_DIR" >/dev/null
}

ensure_main_branch() {
  local current_branch

  current_branch="$(git -C "$TMP_DIR" branch --show-current)"
  if [[ "$current_branch" != "main" ]]; then
    if git -C "$TMP_DIR" show-ref --verify --quiet refs/heads/main; then
      git -C "$TMP_DIR" checkout main >/dev/null
    else
      git -C "$TMP_DIR" branch -M main
    fi
  fi

  if ! git -C "$TMP_DIR" ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
    git -C "$TMP_DIR" push -u origin main >/dev/null
  else
    git -C "$TMP_DIR" branch --set-upstream-to=origin/main main >/dev/null 2>&1 || true
  fi

  gh repo edit "$REPO_SLUG" --default-branch main >/dev/null 2>&1 || true
}

write_seed_files() {
  cat > "${TMP_DIR}/README.md" <<'EOF'
# neato-hive-site

Website distribution repository for Neato Hive.
EOF

  cat > "${TMP_DIR}/.gitignore" <<'EOF'
# Node / Next.js
node_modules/
.next/
out/
dist/
coverage/

# Logs
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# Environment files
.env*

# Vercel
.vercel/
EOF
}

commit_and_push_seed_files() {
  git -C "$TMP_DIR" add README.md .gitignore

  if git -C "$TMP_DIR" diff --cached --quiet; then
    log "Repository seed files already up to date"
    return
  fi

  log "Committing seed files to ${REPO_SLUG}"
  git -C "$TMP_DIR" commit -m "chore: seed site repository" >/dev/null
  git -C "$TMP_DIR" push origin main >/dev/null
}

project_exists() {
  run_vercel projects ls --format=json | python3 -c '
import json, sys
target = sys.argv[1]
data = json.load(sys.stdin)
projects = data.get("projects", [])
raise SystemExit(0 if any(p.get("name") == target for p in projects) else 1)
' "$VERCEL_PROJECT_NAME"
}

create_project() {
  local payload output
  payload="$(mktemp /tmp/neato-hive-site-project.XXXXXX)"
  output="$(mktemp /tmp/neato-hive-site-project-output.XXXXXX)"

  cat > "$payload" <<EOF
{
  "name": "${VERCEL_PROJECT_NAME}",
  "framework": null,
  "gitRepository": {
    "type": "github",
    "repo": "${REPO_SLUG}"
  },
  "publicSource": false
}
EOF

  log "Creating Vercel project: ${VERCEL_PROJECT_NAME}"
  if run_vercel api /v10/projects -X POST --input "$payload" --raw >"$output" 2>&1; then
    rm -f "$payload" "$output"
    return
  fi

  if rg -q "install the GitHub integration first" "$output"; then
    log "GitHub integration is not installed in Vercel; creating project without Git link"
    run_vercel project add "$VERCEL_PROJECT_NAME" >/dev/null
    rm -f "$payload" "$output"
    return
  fi

  cat "$output" >&2
  rm -f "$payload" "$output"
  exit 1
}

ensure_project() {
  if project_exists; then
    log "Vercel project already exists: ${VERCEL_PROJECT_NAME}"
    return
  fi

  create_project
}

project_json() {
  run_vercel api "/v9/projects/${VERCEL_PROJECT_NAME}" --raw
}

project_id() {
  project_json | python3 -c 'import json, sys; print(json.load(sys.stdin)["id"])'
}

project_link_repo() {
  project_json | python3 -c '
import json, sys
link = json.load(sys.stdin).get("link") or {}
print(link.get("repo", ""))
'
}

ensure_project_link() {
  local linked_repo output exit_code
  linked_repo="$(project_link_repo)"

  if [[ "$linked_repo" == "$REPO_SLUG" || "$linked_repo" == "$REPO_NAME" ]]; then
    log "Vercel project already linked to ${REPO_SLUG}"
    return
  fi

  log "Linking local clone to Vercel project ${VERCEL_PROJECT_NAME}"
  run_vercel --cwd "$TMP_DIR" link --yes --project "$VERCEL_PROJECT_NAME" >/dev/null

  log "Connecting Vercel project to GitHub repo ${REPO_SLUG}"
  output="$(run_vercel --cwd "$TMP_DIR" git connect --yes "$REPO_GIT_URL" 2>&1)" || exit_code=$?
  exit_code="${exit_code:-0}"
  if [[ "$exit_code" -ne 0 ]] && ! printf '%s\n' "$output" | grep -qiE 'already (connected|linked|exists)'; then
    printf 'Vercel GitHub integration is not installed for %s. Install it at https://github.com/apps/vercel and rerun this script.\n' "$REPO_SLUG" >&2
    printf '%s\n' "$output" | head -10 >&2
    exit 1
  fi
  if [[ "$exit_code" -ne 0 ]]; then
    log "Vercel git connection already established (idempotent re-run, treating as success)"
  fi

  linked_repo="$(project_link_repo)"
  if [[ "$linked_repo" != "$REPO_SLUG" && "$linked_repo" != "$REPO_NAME" ]]; then
    printf 'Expected Vercel project to be linked to %s but found %s\n' "$REPO_SLUG" "$linked_repo" >&2
    exit 1
  fi
}

print_summary() {
  local vercel_project_id
  vercel_project_id="$(project_id)"

  printf '\n'
  printf 'GitHub repo URL: %s\n' "$REPO_URL"
  printf 'GitHub default branch URL: %s/tree/main\n' "$REPO_URL"
  printf 'Vercel project ID: %s\n' "$vercel_project_id"
  printf 'Vercel production URL pattern: https://%s.vercel.app\n' "$VERCEL_PROJECT_NAME"
}

main() {
  require_cmd gh git python3 vercel

  ensure_repo
  fresh_clone
  ensure_main_branch
  write_seed_files
  commit_and_push_seed_files
  ensure_project
  ensure_project_link
  print_summary
}

main "$@"

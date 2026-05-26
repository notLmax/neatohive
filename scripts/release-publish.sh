#!/usr/bin/env bash
set -euo pipefail

#-----------------------------------------------------------------------
# scripts/release-publish.sh — Publish a built tarball to the site repo.
#
# Usage:  ./scripts/release-publish.sh <version> [--dry-run]
#         e.g.  ./scripts/release-publish.sh 1.5.0
#         e.g.  ./scripts/release-publish.sh 1.5.0 --dry-run
#
# Reads:  /tmp/neato-hive-v<version>.tar.gz
#         /tmp/neato-hive-v<version>.checksums.txt
#
# Pushes to:  Daniel-Neato/neato-hive-site main
#   releases/v<version>/neato-hive-v<version>.tar.gz
#   releases/v<version>/neato-hive-v<version>.checksums.txt
#   releases/v<version>/changelog.md
#   public/releases/v<version>/neato-hive-v<version>.tar.gz
#   public/releases/v<version>/neato-hive-v<version>.checksums.txt
#   public/releases/v<version>/changelog.md
#   releases/current.json
#   releases/index.json
#   public/releases/current.json
#   public/releases/index.json
#   install.sh
#   public/install.sh
#
# Does NOT tag the framework repo. Tagging is owner-paced J.2 ceremony.
#-----------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

DRY_RUN=0
VERSION=""
for ARG in "$@"; do
  case "${ARG}" in
    --dry-run)
      DRY_RUN=1
      ;;
    --help|-h)
      echo "Usage: $0 <version> [--dry-run]"
      exit 0
      ;;
    *)
      if [ -z "${VERSION}" ]; then
        VERSION="${ARG}"
      else
        echo "ERROR: unexpected arg '${ARG}'"
        exit 2
      fi
      ;;
  esac
done

if [ -z "${VERSION}" ]; then
  echo "Usage: $0 <version> [--dry-run]"
  echo "  e.g. $0 1.5.0"
  echo "  e.g. $0 1.5.0 --dry-run"
  exit 2
fi

TARBALL="/tmp/neato-hive-v${VERSION}.tar.gz"
CHECKSUMS="/tmp/neato-hive-v${VERSION}.checksums.txt"
SITE_REPO="Daniel-Neato/neato-hive-site"
SITE_URL="https://neato-hive-site.vercel.app"
WORK_DIR="$(mktemp -d /tmp/neato-hive-site-publish-XXXXXX)"
EXPECTED_REMOTE="https://github.com/${SITE_REPO}.git"

cleanup() {
  if [ -z "${WORK_DIR:-}" ]; then
    return
  fi

  case "${WORK_DIR}" in
    /tmp/neato-hive-site-publish-*)
      ;;
    *)
      echo "==> ERROR: refusing to clean unexpected work dir '${WORK_DIR}'." >&2
      return
      ;;
  esac

  if [ ! -d "${WORK_DIR}" ]; then
    return
  fi

  if [ -d "${WORK_DIR}/.git" ]; then
    REMOTE_URL="$(git -C "${WORK_DIR}" remote get-url origin 2>/dev/null || true)"
    if [ "${REMOTE_URL}" != "${EXPECTED_REMOTE}" ] && [ "${REMOTE_URL}" != "${SITE_REPO}" ]; then
      echo "==> WARNING: skipping cleanup; unexpected origin remote '${REMOTE_URL}'." >&2
      return
    fi
  fi

  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

mirror_file() {
  local src="$1"
  local dst="$2"
  mkdir -p "$(dirname "${dst}")"
  cp -a "${src}" "${dst}"
}

echo "==> Verifying B.1 outputs exist..."
for FILE in "${TARBALL}" "${CHECKSUMS}"; do
  if [ ! -f "${FILE}" ]; then
    echo "==> ERROR: ${FILE} not found. Run scripts/release.sh ${VERSION} first."
    exit 1
  fi
done
echo "    ${TARBALL}: ✓"
echo "    ${CHECKSUMS}: ✓"

echo "==> Verifying gh CLI active account is Daniel-Neato..."
GH_USER="$(gh api user --jq '.login' 2>/dev/null || true)"
if [ "${GH_USER}" != "Daniel-Neato" ]; then
  echo "==> ERROR: gh CLI active account is '${GH_USER}', expected 'Daniel-Neato'."
  echo "==> Switch with: gh auth switch --user Daniel-Neato"
  exit 1
fi
echo "    Active GitHub account: ${GH_USER}"

echo "==> Verifying site repo accessible..."
if ! gh repo view "${SITE_REPO}" --json name >/dev/null 2>&1; then
  echo "==> ERROR: cannot access ${SITE_REPO} with current gh auth."
  exit 1
fi

SHA="$(awk '{print $1; exit}' "${CHECKSUMS}")"
if [ -z "${SHA}" ] || [ "${#SHA}" -ne 64 ]; then
  echo "==> ERROR: SHA-256 from ${CHECKSUMS} is malformed: '${SHA}'"
  exit 1
fi
echo "==> SHA-256: ${SHA}"

RELEASED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "==> released_at: ${RELEASED_AT}"

echo "==> Cloning ${SITE_REPO} to ${WORK_DIR}..."
gh repo clone "${SITE_REPO}" "${WORK_DIR}" -- --depth=1 --quiet
cd "${WORK_DIR}"

if [ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]; then
  echo "==> ERROR: site repo not on main branch."
  exit 1
fi

RELEASE_DIR="releases/v${VERSION}"
PUBLIC_RELEASE_DIR="public/releases/v${VERSION}"
PUBLIC_RELEASES_ROOT="public/releases"
echo "==> Staging release files into ${RELEASE_DIR}/..."
mkdir -p "${RELEASE_DIR}"
cp -a "${TARBALL}" "${RELEASE_DIR}/$(basename "${TARBALL}")"
cp -a "${CHECKSUMS}" "${RELEASE_DIR}/$(basename "${CHECKSUMS}")"
mirror_file "${TARBALL}" "${PUBLIC_RELEASE_DIR}/$(basename "${TARBALL}")"
mirror_file "${CHECKSUMS}" "${PUBLIC_RELEASE_DIR}/$(basename "${CHECKSUMS}")"

if [ -f "${REPO_ROOT}/CHANGELOG.md" ]; then
  echo "==> Extracting CHANGELOG snippet for ${VERSION}..."
  awk -v ver="${VERSION}" '
    BEGIN { in_section = 0 }
    /^## \[/ {
      if (in_section) exit
      if ($0 ~ "\\[" ver "\\]") in_section = 1
    }
    in_section { print }
  ' "${REPO_ROOT}/CHANGELOG.md" > "${RELEASE_DIR}/changelog.md"

  if [ ! -s "${RELEASE_DIR}/changelog.md" ]; then
    echo "==> WARNING: no CHANGELOG entry found for ${VERSION}; writing placeholder."
    printf "## [%s]\n\n(no CHANGELOG entry)\n" "${VERSION}" > "${RELEASE_DIR}/changelog.md"
  fi

  mirror_file "${RELEASE_DIR}/changelog.md" "${PUBLIC_RELEASE_DIR}/changelog.md"
fi

# J.2-prep — push install.sh to site repo root for `curl ... | bash` UX.
# install.sh is the user-facing bootstrap; it lives at framework root and
# must be served from site root (https://<site>/install.sh).
INSTALL_SH_SRC="${REPO_ROOT}/install.sh"
INSTALL_SH_DST="${WORK_DIR}/install.sh"
PUBLIC_INSTALL_SH_DST="${WORK_DIR}/public/install.sh"
if [ ! -f "${INSTALL_SH_SRC}" ]; then
  echo "==> ERROR: framework install.sh missing at ${INSTALL_SH_SRC}." >&2
  echo "==> Publish aborted; restore install.sh and re-run." >&2
  exit 1
fi
cp "${INSTALL_SH_SRC}" "${INSTALL_SH_DST}"
chmod 0755 "${INSTALL_SH_DST}"
mirror_file "${INSTALL_SH_SRC}" "${PUBLIC_INSTALL_SH_DST}"
chmod 0755 "${PUBLIC_INSTALL_SH_DST}"
echo "==> Copied install.sh to site repo root and public/install.sh (mode 0755)."
git -C "${WORK_DIR}" add install.sh public/install.sh

mkdir -p releases "${PUBLIC_RELEASES_ROOT}"
TARBALL_URL="${SITE_URL}/${RELEASE_DIR}/$(basename "${TARBALL}")"
CHANGELOG_URL="${SITE_URL}/changelog.html"

cat > releases/current.json <<EOF
{
  "version": "${VERSION}",
  "tarball_url": "${TARBALL_URL}",
  "checksum_sha256": "${SHA}",
  "released_at": "${RELEASED_AT}",
  "changelog_url": "${CHANGELOG_URL}"
}
EOF
echo "==> releases/current.json written."
mirror_file "releases/current.json" "${PUBLIC_RELEASES_ROOT}/current.json"
echo "==> public/releases/current.json mirrored."

INDEX_FILE="releases/index.json"
PUBLIC_INDEX_FILE="${PUBLIC_RELEASES_ROOT}/index.json"
NEW_ENTRY="$(printf '{"version":"%s","released_at":"%s"}' "${VERSION}" "${RELEASED_AT}")"

if [ -f "${INDEX_FILE}" ]; then
  python3 - "${VERSION}" "${RELEASED_AT}" <<'PY'
import json
import sys

version, released_at = sys.argv[1], sys.argv[2]
path = "releases/index.json"

with open(path, encoding="utf-8") as f:
    data = json.load(f)

data = [entry for entry in data if entry.get("version") != version]
data.insert(0, {"version": version, "released_at": released_at})
data.sort(key=lambda entry: entry.get("released_at", ""), reverse=True)

with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
else
  printf '[\n  %s\n]\n' "${NEW_ENTRY}" > "${INDEX_FILE}"
fi
echo "==> releases/index.json updated."
mirror_file "${INDEX_FILE}" "${PUBLIC_INDEX_FILE}"
echo "==> public/releases/index.json mirrored."

# v1.5.18 — regenerate public/changelog.html from the framework's CHANGELOG.md.
# Previously the file was a v1.5.0 placeholder that never updated; coworkers
# saw "Release notes coming at J.2" while the framework was on v1.5.17. This
# step keeps the site's user-facing changelog page in sync with each release.
CHANGELOG_HTML="public/changelog.html"
SOURCE_CHANGELOG="${REPO_ROOT}/CHANGELOG.md"
if [ -f "${SOURCE_CHANGELOG}" ] && command -v pandoc >/dev/null 2>&1 && [ -f "${CHANGELOG_HTML}" ]; then
  echo "==> Regenerating public/changelog.html from CHANGELOG.md..."
  BODY_TMP="$(mktemp /tmp/neato-hive-changelog-body.XXXXXX.html)"
  pandoc "${SOURCE_CHANGELOG}" -f markdown -t html 2>/dev/null | tail -n +6 > "${BODY_TMP}"
  # Preserve the existing template wrapper (header + nav + footer); replace only
  # the <main>...</main> content with the freshly rendered CHANGELOG body.
  REGEN_TMP="$(mktemp /tmp/neato-hive-changelog-regen.XXXXXX.html)"
  awk -v body_file="${BODY_TMP}" '
    BEGIN { in_main = 0 }
    /<main[^>]*>/ {
      print
      while ((getline line < body_file) > 0) print line
      in_main = 1
      next
    }
    in_main && /<\/main>/ {
      print
      in_main = 0
      next
    }
    !in_main { print }
  ' "${CHANGELOG_HTML}" > "${REGEN_TMP}"
  mv "${REGEN_TMP}" "${CHANGELOG_HTML}"
  rm -f "${BODY_TMP}"
  echo "==> public/changelog.html regenerated."
else
  echo "==> SKIP: changelog.html regen (pandoc unavailable, template missing, or CHANGELOG.md missing)."
fi

git config user.name 'Daniel-Neato'
git config user.email 'daniel.gladstein@neato.com'

git add releases/ public/releases/ public/changelog.html 2>/dev/null || git add releases/ public/releases/
if git diff --cached --quiet; then
  echo "==> No changes to commit (re-publish with identical content?). Exiting clean."
  exit 0
fi

COMMIT_MSG="release: v${VERSION} (${SHA:0:8})"
git commit -m "${COMMIT_MSG}"
echo "==> Committed: ${COMMIT_MSG}"

if [ "${DRY_RUN}" -eq 1 ]; then
  echo ""
  echo "==> DRY RUN — would push to ${SITE_REPO} main:"
  git log -1 --oneline
  git diff HEAD~1 --stat
  echo ""
  echo "==> No push. Site repo unchanged. Worker scratch will be cleaned up."
  exit 0
fi

echo "==> Pushing to ${SITE_REPO} main..."
git push origin main

echo ""
echo "==> Release v${VERSION} published to ${SITE_REPO}."
echo "    tarball:    ${TARBALL_URL}"
echo "    checksums:  ${SITE_URL}/${RELEASE_DIR}/$(basename "${CHECKSUMS}")"
echo "    current:    ${SITE_URL}/releases/current.json"
echo "    Vercel will auto-deploy within ~30-60s."
echo ""
echo "==> Verify (after Vercel deploys):"
echo "    curl -s ${SITE_URL}/releases/current.json | python3 -m json.tool"
echo "    curl -sI ${TARBALL_URL} | head -3   # expect 200 OK"

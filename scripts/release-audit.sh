#!/usr/bin/env bash
set -euo pipefail

#-----------------------------------------------------------------------
# scripts/release-audit.sh — Audit staged release contents or a site-repo publish.
#
# Usage:  ./scripts/release-audit.sh <version>
#         ./scripts/release-audit.sh <version> --site-repo-dir /path/to/site-repo
# The default audit operates on dist-pkg/ and then runs the bash-3.2 smoke
# test gate against the just-built tarball for that version. The site-repo
# mode verifies a published release is mirrored to both releases/ and
# public/releases/.
#-----------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING="${REPO_ROOT}/dist-pkg"
VERSION="${1:-}"
SITE_REPO_DIR=""

if [ "$#" -lt 1 ] || [ "$#" -gt 3 ]; then
  echo "Usage: $0 <version> [--site-repo-dir /path/to/site-repo]"
  exit 2
fi

shift
while [ "$#" -gt 0 ]; do
  case "$1" in
    --site-repo-dir)
      if [ "$#" -lt 2 ]; then
        echo "==> ERROR: --site-repo-dir requires a path."
        exit 2
      fi
      SITE_REPO_DIR="$2"
      shift 2
      ;;
    *)
      echo "==> ERROR: unexpected arg '$1'"
      exit 2
      ;;
  esac
done

REPLACE_LIST="dist bin templates shared skills config src scripts dashboard package.json pnpm-lock.yaml tsconfig.json setup.sh ecosystem.config.cjs .env.example README.md CHANGELOG.md VERSION"
ACTUAL_LIST="$(cd "${STAGING}" && ls -1A 2>/dev/null || true)"

contains_word() {
  case " $1 " in
    *" $2 "*) return 0 ;;
    *) return 1 ;;
  esac
}

require_path() {
  local path="$1"
  if [ -e "${path}" ]; then
    echo "    ✓ ${path}"
    return 0
  fi

  echo "    ✗ ${path}  (MISSING)"
  return 1
}

if [ -n "${SITE_REPO_DIR}" ]; then
  RELEASE_DIR="${SITE_REPO_DIR}/releases/v${VERSION}"
  PUBLIC_RELEASE_DIR="${SITE_REPO_DIR}/public/releases/v${VERSION}"
  CURRENT_JSON="${SITE_REPO_DIR}/releases/current.json"
  PUBLIC_CURRENT_JSON="${SITE_REPO_DIR}/public/releases/current.json"
  INDEX_JSON="${SITE_REPO_DIR}/releases/index.json"
  PUBLIC_INDEX_JSON="${SITE_REPO_DIR}/public/releases/index.json"
  INSTALL_SH="${SITE_REPO_DIR}/install.sh"
  PUBLIC_INSTALL_SH="${SITE_REPO_DIR}/public/install.sh"
  FAIL=0

  if [ ! -d "${SITE_REPO_DIR}" ]; then
    echo "==> ERROR: site repo dir '${SITE_REPO_DIR}' not found."
    exit 1
  fi

  echo "==> Audit of site repo publish for ${VERSION}:"
  echo ""
  echo "  Release payload mirrored to both paths:"
  require_path "${RELEASE_DIR}" || FAIL=1
  require_path "${PUBLIC_RELEASE_DIR}" || FAIL=1
  require_path "${RELEASE_DIR}/neato-hive-v${VERSION}.tar.gz" || FAIL=1
  require_path "${PUBLIC_RELEASE_DIR}/neato-hive-v${VERSION}.tar.gz" || FAIL=1
  require_path "${RELEASE_DIR}/neato-hive-v${VERSION}.checksums.txt" || FAIL=1
  require_path "${PUBLIC_RELEASE_DIR}/neato-hive-v${VERSION}.checksums.txt" || FAIL=1
  require_path "${RELEASE_DIR}/changelog.md" || FAIL=1
  require_path "${PUBLIC_RELEASE_DIR}/changelog.md" || FAIL=1

  echo ""
  echo "  Mirrored metadata + bootstrap:"
  require_path "${CURRENT_JSON}" || FAIL=1
  require_path "${PUBLIC_CURRENT_JSON}" || FAIL=1
  require_path "${INDEX_JSON}" || FAIL=1
  require_path "${PUBLIC_INDEX_JSON}" || FAIL=1
  require_path "${INSTALL_SH}" || FAIL=1
  require_path "${PUBLIC_INSTALL_SH}" || FAIL=1

  echo ""
  if [ "${FAIL}" -eq 0 ]; then
    echo "==> Audit clean. Site repo publish mirrored to releases/ and public/."
    exit 0
  fi

  echo "==> Audit FAILED. Missing mirrored publish artifacts."
  exit 1
fi

if [ ! -d "${STAGING}" ]; then
  echo "==> ERROR: ${STAGING}/ not present. Run release.sh first."
  exit 1
fi

ACTUAL_LIST="$(cd "${STAGING}" && ls -1A 2>/dev/null || true)"

echo "==> Audit of ${STAGING}/ contents for ${VERSION}:"
echo ""
echo "  REPLACE_LIST audit:"
for item in dist bin templates shared skills config src scripts dashboard package.json pnpm-lock.yaml tsconfig.json setup.sh ecosystem.config.cjs .env.example README.md CHANGELOG.md VERSION; do
  if [ -e "${STAGING}/${item}" ]; then
    echo "    ✓ ${item}"
  elif [ "${item}" = "dashboard" ]; then
    echo "    - ${item} (skipped — Phase E placeholder, not present)"
  else
    echo "    ✗ ${item}  (MISSING — release.sh did not stage it)"
  fi
done

echo ""
echo "  PRESERVE_LIST sanity (these MUST be absent):"
LEAK=0
for item in node_modules .git agents data .env .env.local pnpm-workspace.yaml; do
  if [ -e "${STAGING}/${item}" ]; then
    echo "    ✗ ${item}  (LEAKED INTO STAGING — fix release.sh)"
    LEAK=1
  fi
done
if [ "${LEAK}" -eq 0 ]; then
  echo "    ✓ no PRESERVE_LIST / forbidden items detected"
fi

echo ""
echo "  Unexpected items in staging (outside REPLACE_LIST):"
UNEXPECTED=0
for item in ${ACTUAL_LIST}; do
  if ! contains_word "${REPLACE_LIST}" "${item}"; then
    echo "    ? ${item}  (not in REPLACE_LIST — investigate)"
    UNEXPECTED=1
  fi
done
if [ "${UNEXPECTED}" -eq 0 ]; then
  echo "    ✓ no unexpected items"
fi

echo ""
if [ "${LEAK}" -ne 0 ] || [ "${UNEXPECTED}" -ne 0 ]; then
  echo "==> Audit FAILED. See warnings above."
  exit 1
fi

echo "==> Content audit clean. Tarball composition matches REPLACE_LIST."
echo ""
echo "==> Running bash 3.2 smoke test gate..."
if ! "${REPO_ROOT}/scripts/smoke-test-bash3.sh" "${VERSION}"; then
  echo "==> Audit FAILED. Bash 3.2 smoke test did not pass."
  exit 1
fi

echo "==> Audit clean. Tarball composition and bash 3.2 smoke test passed."
exit 0

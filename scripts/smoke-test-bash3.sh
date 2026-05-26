#!/usr/bin/env bash
set -euo pipefail

#-----------------------------------------------------------------------
# scripts/smoke-test-bash3.sh — Pre-release smoke test under bash 3.2.
#
# Usage:  ./scripts/smoke-test-bash3.sh <version>
# Requires the release tarball and checksum sidecar built by release.sh.
# Runs `hive update --check` and `hive update --dry-run` against a fixture
# install extracted from the release tarball, explicitly under bash 3.2.
#-----------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-}"
TARBALL="/tmp/neato-hive-v${VERSION}.tar.gz"
CHECKSUMS="/tmp/neato-hive-v${VERSION}.checksums.txt"

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <version>"
  exit 2
fi

resolve_bash3() {
  local candidate=""
  local version_line=""
  for candidate in /bin/bash /usr/local/bin/bash; do
    [ -x "${candidate}" ] || continue
    version_line="$("${candidate}" --version | head -n 1)"
    case "${version_line}" in
      "GNU bash, version 3.2"*)
        printf '%s\n' "${candidate}|${version_line}"
        return 0
        ;;
    esac
  done
  return 1
}

if [ ! -f "${TARBALL}" ]; then
  echo "==> FAIL: missing tarball ${TARBALL}. Run scripts/release.sh ${VERSION} first."
  exit 1
fi

if [ ! -f "${CHECKSUMS}" ]; then
  echo "==> FAIL: missing checksum sidecar ${CHECKSUMS}. Run scripts/release.sh ${VERSION} first."
  exit 1
fi

if ! BASH3_INFO="$(resolve_bash3)"; then
  echo "==> FAIL: could not find GNU bash 3.2 at /bin/bash or /usr/local/bin/bash."
  exit 1
fi

BASH3_PATH="${BASH3_INFO%%|*}"
BASH3_VERSION="${BASH3_INFO#*|}"
TMP_ROOT="$(mktemp -d "/tmp/hive-bash3-smoke.${VERSION}.XXXXXX")"
SANDBOX="${TMP_ROOT}/install"
FIXTURE_DIR="${TMP_ROOT}/fixture"
HOME_DIR="${TMP_ROOT}/home"
STATE_DIR="${TMP_ROOT}/state"
LOCK_FILE="${TMP_ROOT}/update.lock"
LOCAL_VERSION="0.0.0-bash3-smoke-fixture"
CHECKSUM_SHA="$(awk '{print $1}' "${CHECKSUMS}")"

cleanup() {
  rm -rf "${TMP_ROOT}"
}
trap cleanup EXIT

mkdir -p "${FIXTURE_DIR}" "${HOME_DIR}" "${STATE_DIR}"

echo "==> Bash 3.2 smoke test"
echo "    shell: ${BASH3_PATH}"
echo "    version: ${BASH3_VERSION}"
echo "    tarball: ${TARBALL}"

tar -xzf "${TARBALL}" -C "${TMP_ROOT}"
if [ ! -d "${TMP_ROOT}/dist-pkg" ]; then
  echo "==> FAIL: extracted tarball did not contain dist-pkg/."
  exit 1
fi
mv "${TMP_ROOT}/dist-pkg" "${SANDBOX}"

node -e '
const fs = require("fs");
const pkgPath = process.argv[1];
const version = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
' "${SANDBOX}/package.json" "${LOCAL_VERSION}"
printf '%s\n' "${LOCAL_VERSION}" > "${SANDBOX}/VERSION"

cat > "${FIXTURE_DIR}/current.json" <<EOF
{"version":"${VERSION}","tarball_url":"file://${TARBALL}","checksum_sha256":"${CHECKSUM_SHA}","released_at":"$(date -u +"%Y-%m-%dT%H:%M:%SZ")","changelog_url":"file://${FIXTURE_DIR}/changelog.html"}
EOF
printf '<html><body>bash3 smoke test</body></html>\n' > "${FIXTURE_DIR}/changelog.html"

run_hive() {
  local subcommand="$1"
  shift
  env \
    HOME="${HOME_DIR}" \
    HIVE_INSTALL_ROOT="${SANDBOX}" \
    HIVE_RELEASES_API="file://${FIXTURE_DIR}/current.json" \
    HIVE_LOCK_FILE="${LOCK_FILE}" \
    HIVE_STATE_ROOT="${STATE_DIR}" \
    HIVE_DRY_RUN=1 \
    "${BASH3_PATH}" "${SANDBOX}/bin/hive" "${subcommand}" "$@"
}

echo ""
echo "==> [1/2] hive update --check"
if ! run_hive update --check; then
  echo "==> FAIL: hive update --check failed under ${BASH3_VERSION}."
  exit 1
fi

echo ""
echo "==> [2/2] hive update --dry-run"
if ! run_hive update --dry-run; then
  echo "==> FAIL: hive update --dry-run failed under ${BASH3_VERSION}."
  exit 1
fi

if find "${SANDBOX}" -maxdepth 1 -name '.*.old.*' | grep -q .; then
  echo "==> FAIL: dry-run created overlay shadow files in ${SANDBOX}."
  exit 1
fi

if [ -d "${SANDBOX}/.update-staging" ] && find "${SANDBOX}/.update-staging" -mindepth 1 -print -quit | grep -q .; then
  echo "==> FAIL: dry-run left staging residue in ${SANDBOX}/.update-staging."
  exit 1
fi

ACTUAL_LOCAL_VERSION="$(node -p "require('${SANDBOX}/package.json').version")"
if [ "${ACTUAL_LOCAL_VERSION}" != "${LOCAL_VERSION}" ]; then
  echo "==> FAIL: dry-run mutated sandbox package.json version (${ACTUAL_LOCAL_VERSION})."
  exit 1
fi

echo ""
echo "==> PASS: bash 3.2 smoke test passed (${BASH3_VERSION})."

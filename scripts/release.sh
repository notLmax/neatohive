#!/usr/bin/env bash
set -euo pipefail

#-----------------------------------------------------------------------
# scripts/release.sh — Build a Neato Hive release tarball.
#
# Usage:  ./scripts/release.sh <version>
#         e.g.  ./scripts/release.sh 1.5.0
#         e.g.  ./scripts/release.sh 1.5.0-rc.1
#
# Output:
#   /tmp/neato-hive-v<version>.tar.gz
#   /tmp/neato-hive-v<version>.checksums.txt
#
# Excludes node_modules/ per Q2. Consumers install dependencies after
# extract with `pnpm install --frozen-lockfile`.
#-----------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <version>"
  echo "  e.g. $0 1.5.0"
  echo "  e.g. $0 1.5.0-rc.1"
  exit 2
fi

VERSION="$1"
TARBALL="/tmp/neato-hive-v${VERSION}.tar.gz"
CHECKSUMS="/tmp/neato-hive-v${VERSION}.checksums.txt"
STAGING="${REPO_ROOT}/dist-pkg"
PACKAGE_MANAGER="$(node -e "console.log(require('./package.json').packageManager || '')")"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

resolve_pnpm_cmd() {
  if command -v corepack >/dev/null 2>&1; then
    PNPM_CMD_DESC="corepack pnpm"
    return
  fi

  PNPM_CMD_DESC="npx corepack@0.34.7 pnpm"
}

run_pnpm() {
  if [ "${PNPM_CMD_DESC}" = "corepack pnpm" ]; then
    corepack pnpm "$@"
    return
  fi

  npx corepack@0.34.7 pnpm "$@"
}

echo "==> Verifying repo state..."
if [ -n "$(git status --porcelain)" ]; then
  echo "==> WARNING: working tree has uncommitted changes. Proceeding per B.1 preserve-list guidance."
  git status --short
fi

if [ "${CURRENT_BRANCH}" != "main" ]; then
  echo "==> WARNING: not on main (current: ${CURRENT_BRANCH}). Proceeding anyway."
fi

echo "==> Verifying package.json version matches '${VERSION}'..."
PKG_VERSION="$(node -e "console.log(require('./package.json').version)")"
if [ "${PKG_VERSION}" != "${VERSION}" ]; then
  echo "==> ERROR: package.json version is '${PKG_VERSION}', expected '${VERSION}'."
  echo "==> Either bump package.json or pass the matching version."
  exit 1
fi

echo "==> Verifying packageManager field is present..."
if [ -z "${PACKAGE_MANAGER}" ]; then
  echo "==> ERROR: package.json missing 'packageManager' field. Required for Q2 corepack pinning."
  exit 1
fi
echo "    packageManager = ${PACKAGE_MANAGER}"

resolve_pnpm_cmd
echo "==> Using package runner: ${PNPM_CMD_DESC}"

echo "==> Verifying CHANGELOG entry exists for v${VERSION}..."
if [ ! -f CHANGELOG.md ]; then
  echo "==> ERROR: CHANGELOG.md not found at repo root."
  exit 1
fi
if ! grep -qE "^## \[${VERSION}\]" CHANGELOG.md; then
  echo "==> ERROR: CHANGELOG.md missing entry for ## [${VERSION}]"
  echo "==> Add an entry then re-run."
  exit 1
fi

echo "==> Running pnpm install --frozen-lockfile..."
run_pnpm install --frozen-lockfile

echo "==> Running pnpm build..."
run_pnpm build

echo "==> Running pnpm test..."
run_pnpm test

echo "==> Cleaning prior staging dir..."
rm -rf "${STAGING}"
mkdir -p "${STAGING}"

echo "==> Staging REPLACE_LIST items into ${STAGING}/..."
# F-5 (v1.5.2) — gitignore-respecting staging. cp -a in v1.5.1 leaked
# config/*.local.yaml and shared/exchange/* (all gitignored). Use
# `git ls-files` per-dir to copy ONLY tracked files. dist/ and
# dashboard/node_modules/ are gitignored but intentionally packaged
# (build output + pre-installed deps) — they get a separate explicit copy.
for item in bin templates shared skills config src scripts; do
  if [ ! -d "${REPO_ROOT}/${item}" ]; then
    echo "==> ERROR: required REPLACE_LIST directory '${item}/' not found in repo root."
    exit 1
  fi
  TRACKED_COUNT="$(git -C "${REPO_ROOT}" ls-files -- "${item}" | wc -l | awk '{print $1}')"
  echo "    + ${item}/ (${TRACKED_COUNT} tracked files, gitignored excluded)"
  git -C "${REPO_ROOT}" ls-files -z -- "${item}" | tar --null -cf - -T - | tar -xf - -C "${STAGING}/"
done

# dashboard/: tracked source files via git ls-files, PLUS node_modules
# (gitignored but pre-packaged for fast install on end-user machines).
if [ ! -d "${REPO_ROOT}/dashboard" ]; then
  echo "==> ERROR: required directory 'dashboard/' not found in repo root."
  exit 1
fi
DASHBOARD_TRACKED="$(git -C "${REPO_ROOT}" ls-files -- dashboard | wc -l | awk '{print $1}')"
echo "    + dashboard/ (${DASHBOARD_TRACKED} tracked files + node_modules)"
git -C "${REPO_ROOT}" ls-files -z -- dashboard | tar --null -cf - -T - | tar -xf - -C "${STAGING}/"
if [ -d "${REPO_ROOT}/dashboard/node_modules" ]; then
  cp -a "${REPO_ROOT}/dashboard/node_modules" "${STAGING}/dashboard/node_modules"
else
  echo "==> ERROR: dashboard/node_modules/ missing — run 'cd dashboard && pnpm install' first."
  exit 1
fi

# dist/: gitignored build output. Required for runtime. cp -a is correct
# here — there's no user state in dist/, only TypeScript compile output.
if [ ! -d "${REPO_ROOT}/dist" ]; then
  echo "==> ERROR: dist/ missing — run 'pnpm build' first."
  exit 1
fi
echo "    + dist/ (build output)"
cp -a "${REPO_ROOT}/dist" "${STAGING}/dist"

for file in package.json pnpm-lock.yaml tsconfig.json setup.sh ecosystem.config.cjs .env.example README.md CHANGELOG.md; do
  if [ -f "${REPO_ROOT}/${file}" ]; then
    echo "    + ${file}"
    cp -a "${REPO_ROOT}/${file}" "${STAGING}/${file}"
  else
    echo "==> ERROR: required REPLACE_LIST file '${file}' not found in repo root."
    exit 1
  fi
done

echo "    + VERSION (generated)"
printf "%s" "${VERSION}" > "${STAGING}/VERSION"

echo "==> Creating tarball ${TARBALL}..."
rm -f "${TARBALL}" "${CHECKSUMS}"
tar -czf "${TARBALL}" -C "${REPO_ROOT}" -- dist-pkg/

echo "==> Computing SHA-256..."
SHA="$(shasum -a 256 "${TARBALL}" | awk '{print $1}')"
printf "%s  %s\n" "${SHA}" "$(basename "${TARBALL}")" > "${CHECKSUMS}"
echo "    SHA-256 = ${SHA}"

echo ""
echo "==> Release tarball ready:"
echo "    ${TARBALL}"
echo "    ${CHECKSUMS}"
echo ""
echo "==> Tarball size: $(du -h "${TARBALL}" | awk '{print $1}')"
echo "==> Inspect contents:  tar -tzf ${TARBALL} | head -30"
echo "==> Audit:             bash scripts/release-audit.sh ${VERSION}"
echo "==> B.2 will push to site repo + update current.json + index.json."

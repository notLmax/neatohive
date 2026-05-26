#!/usr/bin/env bash
set -euo pipefail

#-----------------------------------------------------------------------
# install.sh — Neato Hive fresh-install bootstrap.
#
# Usage:
#   curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash
#   curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash -s -- --check-only
#   bash install.sh [OPTIONS]
#
# Default mode: auto-install missing prereqs (Node, pm2, tar) via
# the platform package manager (Homebrew on macOS, apt-get on Ubuntu),
# then download the latest release tarball, verify its checksum, extract
# it to $HOME/neato-hive, generate a dashboard token, write .env.
#
# Power users can opt out with --no-install-prereqs (abort if any missing)
# or --interactive-prereqs (prompt before each install).
#
# Existing installs are detected and aborted — use `hive update` instead.
#
# v1.5.0 F.2 — Spec: docs/v1.5.0-tasks/F.2-fresh-install.md
# Consumes:
#   - F.1 scripts/install-prereqs.sh (post-install, in-tarball)
#   - C.5 hive update --check --json (post-install)
#   - D.x dashboard endpoints (post-install)
# Produces:
#   - $HOME/neato-hive (the install)
#   - $HOME/neato-hive/.env (HIVE_DASHBOARD_TOKEN)
#   - $HOME/.config/neato-hive/dashboard-token (mode 0600)
#-----------------------------------------------------------------------

SCRIPT_VERSION="1.5.15"
MIN_NODE_MAJOR=18
MIN_NODE_VERSION="18.0.0"
DEFAULT_API_URL="https://neato-hive-site.vercel.app/releases/current.json"
DEFAULT_TARGET_DIR="${HIVE_INSTALL_TARGET:-$HOME/neato-hive}"
DEFAULT_TOKEN_MIRROR_DIR="${HIVE_TOKEN_MIRROR_DIR:-$HOME/.config/neato-hive}"
PREREQ_ORDER=(bash curl tar node pnpm pm2 openssl)
RUNTIME_PREREQS_DARWIN=(flock:flock gh:gh jq:jq tmux:tmux ffmpeg:ffmpeg pandoc:pandoc sqlite3:sqlite3)
RUNTIME_PREREQS_LINUX=(flock:util-linux gh:gh jq:jq tmux:tmux ffmpeg:ffmpeg pandoc:pandoc sqlite3:sqlite3)

USE_COLOR=0
MODE="auto"
SKIP_CHECKSUM=0
ACKNOWLEDGED_AUTO_INSTALL=0
FORCE_MIGRATE=0
FORCE_FRESH=0
REPAIR_MODE=0
TARGET_DIR="${DEFAULT_TARGET_DIR}"
API_URL="${HIVE_RELEASES_API:-$DEFAULT_API_URL}"
TOKEN_MIRROR_DIR="${DEFAULT_TOKEN_MIRROR_DIR}"
INSTALL_DASHBOARD_URL="http://localhost:7777"
OS_NAME=""
PACKAGE_MANAGER=""
DETECTED_STATUS=""
DETECTED_VERSION=""
RELEASE_VERSION=""
RELEASE_TARBALL_URL=""
RELEASE_CHECKSUM=""
METADATA_FILE=""
TARBALL_FILE=""
STAGING_DIR=""
TARGET_PARENT=""

PREREQ_NAMES=()
PREREQ_STATUSES=()
PREREQ_VERSIONS=()

if [ -t 1 ]; then
  USE_COLOR=1
fi

usage() {
  cat <<'EOF'
Usage: bash install.sh [OPTIONS]
  curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash
  curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash -s -- --check-only
  curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash -s -- --repair

Options:
  --check-only             Dry run. Detect OS + prereqs + existing install; report; exit 0/1.
                           No tarball download, no install actions, no token generation.
  --no-install-prereqs     Abort with exit 1 if any required prereq is missing.
                           Skip the auto-install step.
  --interactive-prereqs    Prompt [Y/n] before installing each missing prereq.
                           Default behavior is auto-install without prompts.
  --yes, -y                Explicit acknowledgment of default auto-install behavior.
                           No-op when already default; reserved for future safety prompts.
  --target-dir=<path>      Override the install location. Default: $HOME/neato-hive.
                           For testing; production users do not pass this.
  --api-url=<url>          Override the release-metadata URL.
                           Default: $HIVE_RELEASES_API or https://neato-hive-site.vercel.app/releases/current.json.
                           For testing.
  --skip-checksum          DO NOT USE. Disables SHA-256 verification of the tarball.
                           For testing only. Worker MUST flag if used in production.
  --migrate                Force legacy absorb-mode even on a modern (v1.5.0+) install.
                           Snapshots existing install, fresh-installs the current release,
                           absorbs your state (.env, agents/, data/, config overlays),
                           re-registers PM2. Use for recovery / corruption / drift fixes.
                           Auto-fires on legacy (v1.4.x or earlier) installs without this flag.
  --fresh                  Force fresh install. Moves the existing install to
                           ~/neato-hive.wiped-<ts>/ and starts clean. Destructive — no absorb.
                           Use only when you want a true fresh start.
  --repair                 Refresh bin/hive from the latest release without touching anything else.
                           For recovering from a broken hive update flow.
  -h, --help               Show this help and exit 0.
  --version                Show script version and exit 0.

Exit codes:
  0   Install succeeded; dashboard token generated; next-steps printed.
  1   Install aborted (existing install detected, prereq missing with --no-install-prereqs,
      checksum mismatch, download failure, extract failure, post-install verification failure).
  2   Bad args, unsupported OS, or fatal pre-condition.
EOF
}

color() {
  if [ "${USE_COLOR}" -ne 1 ]; then
    return 0
  fi

  case "$1" in
    red) printf '\033[31m' ;;
    green) printf '\033[32m' ;;
    yellow) printf '\033[33m' ;;
    blue) printf '\033[34m' ;;
    bold) printf '\033[1m' ;;
    reset) printf '\033[0m' ;;
  esac
}

print_step() {
  printf '%s==>%s %s\n' "$(color blue)" "$(color reset)" "$*"
}

print_success() {
  printf '  %s✓%s %s\n' "$(color green)" "$(color reset)" "$*"
}

print_warning() {
  printf '  %s!%s %s\n' "$(color yellow)" "$(color reset)" "$*"
}

print_error() {
  printf '%sERROR:%s %s\n' "$(color red)" "$(color reset)" "$*" >&2
}

die() {
  local code=$1
  shift
  print_error "$*"
  exit "${code}"
}

run_privileged() {
  if [ "${OS_NAME}" = "linux" ] && [ "$(id -u)" -ne 0 ]; then
    sudo "$@"
    return
  fi

  "$@"
}

cleanup_temp_artifacts() {
  if [ -n "${STAGING_DIR}" ] && [ -d "${STAGING_DIR}" ]; then
    rm -rf "${STAGING_DIR}"
  fi
  if [ -n "${TARBALL_FILE}" ] && [ -f "${TARBALL_FILE}" ]; then
    rm -f "${TARBALL_FILE}"
  fi
  if [ -n "${METADATA_FILE}" ] && [ -f "${METADATA_FILE}" ]; then
    rm -f "${METADATA_FILE}"
  fi
}

trap cleanup_temp_artifacts EXIT

parse_args() {
  local mode_seen=""

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --check-only)
        if [ -n "${mode_seen}" ] && [ "${mode_seen}" != "check-only" ]; then
          die 2 "--${mode_seen} and --check-only are mutually exclusive"
        fi
        MODE="check-only"
        mode_seen="check-only"
        ;;
      --no-install-prereqs)
        if [ -n "${mode_seen}" ] && [ "${mode_seen}" != "no-install-prereqs" ]; then
          die 2 "--${mode_seen} and --no-install-prereqs are mutually exclusive"
        fi
        MODE="no-install-prereqs"
        mode_seen="no-install-prereqs"
        ;;
      --interactive-prereqs)
        if [ -n "${mode_seen}" ] && [ "${mode_seen}" != "interactive-prereqs" ]; then
          die 2 "--${mode_seen} and --interactive-prereqs are mutually exclusive"
        fi
        MODE="interactive-prereqs"
        mode_seen="interactive-prereqs"
        ;;
      --yes|-y)
        ACKNOWLEDGED_AUTO_INSTALL=1
        ;;
      --target-dir=*)
        TARGET_DIR="${1#*=}"
        ;;
      --api-url=*)
        API_URL="${1#*=}"
        ;;
      --skip-checksum)
        SKIP_CHECKSUM=1
        ;;
      --migrate)
        # v1.5.15 — force legacy absorb-mode even on modern installs (recovery)
        if [ -n "${mode_seen}" ] && [ "${mode_seen}" != "migrate" ]; then
          die 2 "--${mode_seen} and --migrate are mutually exclusive"
        fi
        mode_seen="migrate"
        FORCE_MIGRATE=1
        ;;
      --fresh)
        # v1.5.15 — force fresh install (wipes existing, no absorb)
        if [ -n "${mode_seen}" ] && [ "${mode_seen}" != "fresh" ]; then
          die 2 "--${mode_seen} and --fresh are mutually exclusive"
        fi
        mode_seen="fresh"
        FORCE_FRESH=1
        ;;
      --repair)
        if [ -n "${mode_seen:-}" ]; then
          die 2 "--${mode_seen} and --repair are mutually exclusive"
        fi
        mode_seen="repair"
        REPAIR_MODE=1
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      --version)
        printf '%s\n' "${SCRIPT_VERSION}"
        exit 0
        ;;
      *)
        die 2 "unknown argument '$1'"
        ;;
    esac
    shift
  done

  if [ -z "${TARGET_DIR}" ]; then
    die 2 "--target-dir must not be empty"
  fi
  if [ -z "${API_URL}" ]; then
    die 2 "--api-url must not be empty"
  fi
}

detect_os() {
  local uname_value

  uname_value=$(uname)
  case "${uname_value}" in
    Darwin)
      OS_NAME="darwin"
      ;;
    Linux)
      if ! command -v apt-get >/dev/null 2>&1; then
        die 2 "unsupported Linux host: apt-get not found. Neato Hive supports Ubuntu Linux."
      fi
      OS_NAME="linux"
      ;;
    *)
      die 2 "unsupported OS '${uname_value}'. Neato Hive supports macOS and Ubuntu Linux."
      ;;
  esac
}

detect_package_manager() {
  case "${OS_NAME}" in
    darwin)
      PACKAGE_MANAGER="brew"
      if ! command -v brew >/dev/null 2>&1; then
        print_error "Homebrew is required on macOS to bootstrap Neato Hive."
        printf 'Install it first with:\n' >&2
        printf '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n' >&2
        exit 2
      fi
      ;;
    linux)
      PACKAGE_MANAGER="apt-get"
      ;;
  esac
}

_check_bash() {
  DETECTED_VERSION="${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}.${BASH_VERSINFO[2]}"
  if [ "${BASH_VERSINFO[0]}" -gt 3 ] || { [ "${BASH_VERSINFO[0]}" -eq 3 ] && [ "${BASH_VERSINFO[1]}" -ge 2 ]; }; then
    DETECTED_STATUS="ok"
    return 0
  fi

  DETECTED_STATUS="too-old"
  return 1
}

_check_curl() {
  if ! command -v curl >/dev/null 2>&1; then
    DETECTED_STATUS="missing"
    DETECTED_VERSION=""
    return 1
  fi

  DETECTED_VERSION=$(curl --version 2>/dev/null | awk 'NR==1 { print $2 }')
  DETECTED_STATUS="ok"
  return 0
}

_check_tar() {
  if ! command -v tar >/dev/null 2>&1; then
    DETECTED_STATUS="missing"
    DETECTED_VERSION=""
    return 1
  fi

  DETECTED_VERSION=$(tar --version 2>/dev/null | awk 'NR==1 { print $1 " " $2 }')
  DETECTED_STATUS="ok"
  return 0
}

_check_node() {
  local raw major

  if ! command -v node >/dev/null 2>&1; then
    DETECTED_STATUS="missing"
    DETECTED_VERSION=""
    return 1
  fi

  raw=$(node --version 2>/dev/null)
  DETECTED_VERSION="${raw#v}"
  major=$(printf '%s\n' "${DETECTED_VERSION}" | awk -F. 'NF { print $1 }')
  if [ -n "${major}" ] && [ "${major}" -ge "${MIN_NODE_MAJOR}" ]; then
    DETECTED_STATUS="ok"
    return 0
  fi

  DETECTED_STATUS="too-old"
  return 1
}

_check_pnpm() {
  if ! command -v pnpm >/dev/null 2>&1; then
    DETECTED_STATUS="missing"
    DETECTED_VERSION=""
    return 1
  fi

  DETECTED_VERSION=$(pnpm --version 2>/dev/null | head -1)
  DETECTED_STATUS="ok"
  return 0
}

_check_pm2() {
  if ! command -v pm2 >/dev/null 2>&1; then
    DETECTED_STATUS="missing"
    DETECTED_VERSION=""
    return 1
  fi

  DETECTED_VERSION=$(pm2 --version 2>/dev/null | tail -1)
  DETECTED_STATUS="ok"
  return 0
}

_check_openssl() {
  if ! command -v openssl >/dev/null 2>&1; then
    DETECTED_STATUS="missing"
    DETECTED_VERSION=""
    return 1
  fi

  DETECTED_VERSION=$(openssl version 2>/dev/null | awk '{ print $2 }')
  DETECTED_STATUS="ok"
  return 0
}

detect_prereq() {
  local name=$1

  DETECTED_STATUS="missing"
  DETECTED_VERSION=""

  case "${name}" in
    bash) _check_bash ;;
    curl) _check_curl ;;
    tar) _check_tar ;;
    node) _check_node ;;
    pnpm) _check_pnpm ;;
    pm2) _check_pm2 ;;
    openssl) _check_openssl ;;
    *)
      die 2 "internal error: unknown prereq '${name}'"
      ;;
  esac
}

collect_prereq_state() {
  local name

  PREREQ_NAMES=()
  PREREQ_STATUSES=()
  PREREQ_VERSIONS=()

  for name in "${PREREQ_ORDER[@]}"; do
    detect_prereq "${name}" || true
    PREREQ_NAMES+=("${name}")
    PREREQ_STATUSES+=("${DETECTED_STATUS}")
    PREREQ_VERSIONS+=("${DETECTED_VERSION}")
  done
}

has_prereq_failures() {
  local i

  for i in "${!PREREQ_NAMES[@]}"; do
    if [ "${PREREQ_STATUSES[$i]}" != "ok" ]; then
      # setup.sh step 2 owns pnpm bootstrap now via corepack, so install.sh
      # only checks for pnpm here and defers a missing binary to the handoff.
      if [ "${PREREQ_NAMES[$i]}" = "pnpm" ] && [ "${PREREQ_STATUSES[$i]}" = "missing" ]; then
        continue
      fi
      return 0
    fi
  done
  return 1
}

has_too_old_node() {
  local i

  for i in "${!PREREQ_NAMES[@]}"; do
    if [ "${PREREQ_NAMES[$i]}" = "node" ] && [ "${PREREQ_STATUSES[$i]}" = "too-old" ]; then
      return 0
    fi
  done
  return 1
}

describe_install_command() {
  local prefix=""

  if [ "${OS_NAME}" = "linux" ] && [ "$(id -u)" -ne 0 ]; then
    prefix="sudo "
  fi

  case "$1:${OS_NAME}" in
    node:darwin)
      printf 'brew install node'
      ;;
    node:linux)
      printf 'curl -fsSL https://deb.nodesource.com/setup_22.x | %sbash - && %sapt-get install -y nodejs' "${prefix}" "${prefix}"
      ;;
    pm2:darwin|pm2:linux)
      printf 'npm install -g pm2'
      ;;
    tar:linux)
      printf '%sapt-get install -y tar' "${prefix}"
      ;;
    *)
      printf ''
      ;;
  esac
}

_install_node() {
  local setup_script

  case "${OS_NAME}" in
    darwin)
      brew install node
      ;;
    linux)
      setup_script=$(mktemp /tmp/neato-hive-nodesource-XXXXXX.sh)
      curl -fsSL https://deb.nodesource.com/setup_22.x -o "${setup_script}"
      run_privileged bash "${setup_script}"
      rm -f "${setup_script}"
      run_privileged apt-get install -y nodejs
      ;;
  esac
}

_install_pm2() {
  npm install -g pm2
}

_install_tar() {
  case "${OS_NAME}" in
    linux)
      run_privileged apt-get install -y tar
      ;;
    *)
      die 1 "tar is missing and cannot be bootstrapped automatically on macOS."
      ;;
  esac
}

install_prereq() {
  case "$1" in
    node) _install_node ;;
    pm2) _install_pm2 ;;
    tar) _install_tar ;;
    *)
      die 1 "cannot auto-install prereq '$1'"
      ;;
  esac
}

prereq_ok_message() {
  local name=$1
  local version=$2

  case "${name}" in
    bash)
      printf 'bash %s' "${version}"
      ;;
    curl)
      printf 'curl %s' "${version}"
      ;;
    tar)
      printf 'tar (%s)' "${version}"
      ;;
    node)
      printf 'node %s' "${version}"
      ;;
    pnpm)
      printf 'pnpm %s' "${version}"
      ;;
    pm2)
      printf 'pm2 %s' "${version}"
      ;;
    openssl)
      printf 'openssl %s' "${version}"
      ;;
  esac
}

show_prereq_report() {
  local i name status version

  for i in "${!PREREQ_NAMES[@]}"; do
    name=${PREREQ_NAMES[$i]}
    status=${PREREQ_STATUSES[$i]}
    version=${PREREQ_VERSIONS[$i]}
    if [ "${status}" = "ok" ]; then
      print_success "$(prereq_ok_message "${name}" "${version}")"
      continue
    fi

    if [ "${name}" = "node" ] && [ "${status}" = "too-old" ]; then
      print_error "node ${version} is too old; need >= ${MIN_NODE_VERSION}. Upgrade manually via brew upgrade node or NodeSource."
    elif [ "${name}" = "pnpm" ]; then
      print_warning "pnpm is missing (setup.sh step 2 will bootstrap it via corepack or npm)"
    else
      print_warning "${name} is missing"
    fi
  done
}

prompt_to_install() {
  local name=$1
  local answer=""

  if [ ! -r /dev/tty ]; then
    print_error "--interactive-prereqs requested, but no TTY is available for prompting."
    return 1
  fi

  printf 'Install missing prereq %s? [Y/n] ' "${name}" > /dev/tty
  if ! IFS= read -r answer < /dev/tty; then
    return 1
  fi

  case "${answer}" in
    ""|y|Y|yes|YES)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

install_missing_prereqs() {
  local i name status install_cmd

  if has_too_old_node; then
    return 1
  fi

  for i in "${!PREREQ_NAMES[@]}"; do
    name=${PREREQ_NAMES[$i]}
    status=${PREREQ_STATUSES[$i]}
    if [ "${status}" = "ok" ]; then
      continue
    fi

    if [ "${name}" = "pnpm" ] && [ "${status}" = "missing" ]; then
      print_warning "pnpm is missing — deferring bootstrap to setup.sh step 2"
      continue
    fi

    install_cmd=$(describe_install_command "${name}")
    if [ -z "${install_cmd}" ]; then
      print_error "${name} is missing and cannot be auto-installed by install.sh."
      return 1
    fi

    if [ "${MODE}" = "interactive-prereqs" ]; then
      print_warning "${name} is missing"
      if ! prompt_to_install "${name}"; then
        print_error "missing prereq '${name}' was not installed."
        return 1
      fi
      print_step "Installing ${name} via ${install_cmd}"
    else
      print_warning "${name} is missing — auto-installing via \`${install_cmd}\`..."
    fi

    install_prereq "${name}"
    detect_prereq "${name}" || true
    if [ "${DETECTED_STATUS}" != "ok" ]; then
      print_error "failed to satisfy prereq '${name}' after install attempt."
      return 1
    fi
    print_success "$(prereq_ok_message "${name}" "${DETECTED_VERSION}") installed"
  done

  collect_prereq_state
  if has_prereq_failures; then
    return 1
  fi
  return 0
}

runtime_prereq_install_hint() {
  case "${OS_NAME}" in
    darwin)
      printf 'brew install %s' "$1"
      ;;
    linux)
      if [ "$(id -u)" -ne 0 ]; then
        printf 'sudo apt-get install -y %s' "$1"
      else
        printf 'apt-get install -y %s' "$1"
      fi
      ;;
  esac
}

install_runtime_prereqs() {
  local -a entries=()
  local -a missing_entries=()
  local -a missing_bins=()
  local entry cmd pkg still_missing=""

  case "${OS_NAME}" in
    darwin)
      entries=("${RUNTIME_PREREQS_DARWIN[@]}")
      ;;
    linux)
      entries=("${RUNTIME_PREREQS_LINUX[@]}")
      ;;
    *)
      print_warning "unknown OS '${OS_NAME}' — skipping runtime prereq auto-install"
      return 0
      ;;
  esac

  for entry in "${entries[@]}"; do
    cmd=${entry%%:*}
    if ! command -v "${cmd}" >/dev/null 2>&1; then
      missing_entries+=("${entry}")
      missing_bins+=("${cmd}")
    fi
  done

  if [ "${#missing_entries[@]}" -eq 0 ]; then
    print_success "all runtime prereqs present"
    return 0
  fi

  print_warning "missing runtime prereqs: ${missing_bins[*]}"

  if [ "${MODE}" = "no-install-prereqs" ]; then
    print_warning "--no-install-prereqs requested — skipping runtime prereq auto-install"
  elif [ "${OS_NAME}" = "darwin" ]; then
    if ! command -v brew >/dev/null 2>&1; then
      print_warning "Homebrew not installed — cannot auto-install runtime prereqs"
      printf '  Install Homebrew first with:\n'
      printf "    /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"\n"
    else
      print_step "Installing runtime prereqs via Homebrew"
      for entry in "${missing_entries[@]}"; do
        cmd=${entry%%:*}
        pkg=${entry##*:}
        if [ "${MODE}" = "interactive-prereqs" ]; then
          if ! prompt_to_install "${cmd}"; then
            print_warning "skipping runtime prereq '${cmd}' at user request"
            continue
          fi
        fi
        if brew install "${pkg}" >/dev/null 2>&1; then
          print_success "${cmd} installed"
        else
          print_warning "${cmd} install failed — try \`$(runtime_prereq_install_hint "${pkg}")\`"
        fi
      done
    fi
  else
    print_step "Installing runtime prereqs via apt-get"
    if ! sudo -n true >/dev/null 2>&1; then
      print_warning "sudo password may be required for apt-get install"
    fi
    run_privileged apt-get update -qq >/dev/null 2>&1 || true
    for entry in "${missing_entries[@]}"; do
      cmd=${entry%%:*}
      pkg=${entry##*:}
      if [ "${MODE}" = "interactive-prereqs" ]; then
        if ! prompt_to_install "${cmd}"; then
          print_warning "skipping runtime prereq '${cmd}' at user request"
          continue
        fi
      fi
      if run_privileged apt-get install -y -qq "${pkg}" >/dev/null 2>&1; then
        print_success "${cmd} installed"
      else
        print_warning "${cmd} install failed — try \`$(runtime_prereq_install_hint "${pkg}")\`"
      fi
    done
  fi

  for entry in "${entries[@]}"; do
    cmd=${entry%%:*}
    if ! command -v "${cmd}" >/dev/null 2>&1; then
      still_missing="${still_missing}${still_missing:+ }${cmd}"
    fi
  done

  if [ -n "${still_missing}" ]; then
    print_warning "runtime prereqs still missing: ${still_missing}"
    print_warning "install them manually and re-run \`hive doctor\` to verify"
  else
    print_success "all runtime prereqs satisfied"
  fi

  return 0
}

check_existing_install() {
  if [ -d "${TARGET_DIR}/agents" ] \
    || [ -f "${TARGET_DIR}/package.json" ] \
    || [ -f "${TARGET_DIR}/.env" ] \
    || [ -d "${TARGET_DIR}/.git" ]; then
    return 0
  fi
  return 1
}

# v1.5.15 — classify existing install for branched handling.
# Returns one of: "fresh", "legacy", "modern".
classify_existing_install() {
  if ! check_existing_install; then
    echo "fresh"
    return
  fi

  local pkg="${TARGET_DIR}/package.json"
  if [ ! -f "${pkg}" ]; then
    # No package.json but install dir exists — pre-modern.
    echo "legacy"
    return
  fi

  local version
  version=$(node -e "try { console.log(JSON.parse(require('fs').readFileSync('${pkg}','utf8')).version || 'unknown') } catch(e) { console.log('unknown') }" 2>/dev/null || echo "unknown")

  if [ "${version}" = "unknown" ]; then
    echo "legacy"
    return
  fi

  local major minor
  major=$(echo "${version}" | cut -d. -f1)
  minor=$(echo "${version}" | cut -d. -f2)

  # Modern boundary: v1.5.0+. Anything earlier (including no major/minor) is legacy.
  if ! [[ "${major}" =~ ^[0-9]+$ ]] || ! [[ "${minor}" =~ ^[0-9]+$ ]]; then
    echo "legacy"
    return
  fi
  if [ "${major}" -gt 1 ]; then
    echo "modern"
    return
  fi
  if [ "${major}" -eq 1 ] && [ "${minor}" -ge 5 ]; then
    echo "modern"
    return
  fi
  echo "legacy"
}

# v1.5.15 — get existing install's version string, or "unknown".
get_existing_install_version() {
  local pkg="${TARGET_DIR}/package.json"
  if [ ! -f "${pkg}" ]; then
    echo "unknown"
    return
  fi
  node -e "try { console.log(JSON.parse(require('fs').readFileSync('${pkg}','utf8')).version || 'unknown') } catch(e) { console.log('unknown') }" 2>/dev/null || echo "unknown"
}

# v1.5.15 — modern install refusal message.
print_modern_install_message() {
  local version="$1"
  printf '\n' >&2
  printf 'Modern Neato Hive (v%s) already installed at %s.\n\n' "${version}" "${TARGET_DIR}" >&2
  printf 'For routine updates, use:\n' >&2
  printf '  hive update\n\n' >&2
  printf 'To force re-baseline (rare — recovery, corruption fix, accumulated drift):\n' >&2
  printf '  curl -fsSL %s | bash -s -- --migrate\n\n' "https://neato-hive-site.vercel.app/install.sh" >&2
  printf 'To start fresh (wipes existing — destructive):\n' >&2
  printf '  curl -fsSL %s | bash -s -- --fresh\n' "https://neato-hive-site.vercel.app/install.sh" >&2
  exit 0
}

# v1.5.15 — full legacy absorb flow. Snapshot existing install, fresh-install
# the new framework, absorb user state from the snapshot, re-register PM2.
run_legacy_absorb_flow() {
  local existing_version="$1"
  local ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local snapshot_dir="${TARGET_DIR}.backup-${ts}"
  local old_dir="${TARGET_DIR}.old-${ts}"

  printf '\n'
  print_step "Legacy Hive Detected — Absorb Mode"
  printf '  Existing install: %s (v%s)\n' "${TARGET_DIR}" "${existing_version}"
  printf '  Target version:   v%s\n' "${RELEASE_VERSION}"
  printf '\n'
  printf '  Plan:\n'
  printf '    1. Stop PM2 processes (brief Discord-bot downtime)\n'
  printf '    2. Create snapshot: %s\n' "${snapshot_dir}"
  printf '    3. Move old install: %s\n' "${old_dir}"
  printf '    4. Install fresh framework into %s\n' "${TARGET_DIR}"
  printf '    5. Absorb your state from snapshot (.env, agents/, data/, config overlays)\n'
  printf '    6. Re-register PM2 daemons + per-agent processes\n'
  printf '    7. Run hive doctor to verify\n'
  printf '\n'
  printf '  Recovery: snapshot at %s preserved until you manually delete it.\n' "${snapshot_dir}"
  printf '\n'

  # Step 1: quiesce PM2
  print_step "Step 1/7 — Stopping PM2 processes"
  if command -v pm2 >/dev/null 2>&1; then
    pm2 stop all >/dev/null 2>&1 || true
    print_success "PM2 processes stopped"
  else
    print_warning "pm2 not installed — skipping"
  fi

  # Step 2: snapshot
  print_step "Step 2/7 — Creating snapshot at ${snapshot_dir}"
  cp -R "${TARGET_DIR}" "${snapshot_dir}"
  print_success "Snapshot created ($(du -sh "${snapshot_dir}" 2>/dev/null | awk '{print $1}'))"

  # Step 3: move old install aside
  print_step "Step 3/7 — Moving old install to ${old_dir}"
  mv "${TARGET_DIR}" "${old_dir}"
  print_success "Old install preserved at ${old_dir}"

  # Step 4: fresh install (uses existing extract + swap + pnpm-install path)
  print_step "Step 4/7 — Installing fresh v${RELEASE_VERSION}"
  stage_extract
  atomic_swap
  cleanup_staging_and_tarball
  run_pnpm_install
  install_runtime_prereqs
  print_success "Fresh framework installed"

  # Step 5: absorb user state from snapshot
  print_step "Step 5/7 — Absorbing user state from snapshot"
  absorb_state_from_snapshot "${snapshot_dir}"

  # Step 6: re-register PM2 daemons + agents
  print_step "Step 6/7 — Re-registering PM2 daemons + agents"
  reregister_pm2_after_absorb

  # Step 7: hive doctor verification
  print_step "Step 7/7 — Verifying with hive doctor"
  cd "${TARGET_DIR}" || true
  if [ -x bin/hive ]; then
    ./bin/hive doctor 2>&1 | tail -30 || true
  else
    print_warning "bin/hive not executable — skipping doctor run"
  fi

  printf '\n'
  print_step "Migration Complete"
  printf '  Snapshot preserved at:\n'
  printf '    %s\n' "${snapshot_dir}"
  printf '  Old install preserved at:\n'
  printf '    %s\n' "${old_dir}"
  printf '\n'
  printf '  After verifying everything works (test Discord, run hive doctor again, etc.),\n'
  printf '  delete the snapshots when you are comfortable:\n'
  printf '    rm -rf %s %s\n' "${snapshot_dir}" "${old_dir}"
  printf '\n'
  exit 0
}

# v1.5.15 — copy explicit user-state files from snapshot into the fresh install.
absorb_state_from_snapshot() {
  local snap="$1"
  local copied=0

  # .env (mode preserved via -a)
  if [ -f "${snap}/.env" ]; then
    cp -a "${snap}/.env" "${TARGET_DIR}/.env"
    printf '    .env\n'
    copied=$((copied + 1))
  fi
  if [ -f "${snap}/.env.local" ]; then
    cp -a "${snap}/.env.local" "${TARGET_DIR}/.env.local"
    printf '    .env.local\n'
    copied=$((copied + 1))
  fi

  # Config overlays + user backups
  for f in agents.local.yaml users.local.yaml; do
    if [ -f "${snap}/config/${f}" ]; then
      cp -a "${snap}/config/${f}" "${TARGET_DIR}/config/${f}"
      printf '    config/%s\n' "${f}"
      copied=$((copied + 1))
    fi
  done
  for f in "${snap}/config/config.yaml.backup-"*; do
    if [ -f "${f}" ]; then
      cp -a "${f}" "${TARGET_DIR}/config/$(basename "${f}")"
      printf '    config/%s\n' "$(basename "${f}")"
      copied=$((copied + 1))
    fi
  done

  # agents/ — copy each agent dir wholesale (skip if empty)
  if [ -d "${snap}/agents" ]; then
    for agent_dir in "${snap}/agents/"*/; do
      [ -d "${agent_dir}" ] || continue
      local agent_name
      agent_name=$(basename "${agent_dir}")
      # Skip if no IDENTITY.md (not a real agent)
      if [ -f "${agent_dir}/IDENTITY.md" ]; then
        mkdir -p "${TARGET_DIR}/agents"
        cp -R "${agent_dir}" "${TARGET_DIR}/agents/${agent_name}"
        printf '    agents/%s/\n' "${agent_name}"
        copied=$((copied + 1))
      fi
    done
  fi

  # data/ wholesale
  if [ -d "${snap}/data" ]; then
    mkdir -p "${TARGET_DIR}/data"
    cp -R "${snap}/data/." "${TARGET_DIR}/data/" 2>/dev/null || true
    printf '    data/\n'
    copied=$((copied + 1))
  fi

  print_success "${copied} state item(s) absorbed"
}

# v1.5.15 — re-register PM2 daemons + per-agent processes after absorb.
reregister_pm2_after_absorb() {
  cd "${TARGET_DIR}" || return 1

  if ! command -v pm2 >/dev/null 2>&1; then
    print_warning "pm2 not installed — skipping daemon reconcile (user must run 'hive bootstrap' later)"
    return 0
  fi

  # Bootstrap ecosystem daemons (hive-runner + hive-dashboard)
  if [ -f ecosystem.config.cjs ]; then
    if pm2 startOrReload ecosystem.config.cjs --update-env >/dev/null 2>&1; then
      printf '    ecosystem daemons (hive-runner + hive-dashboard)\n'
    else
      print_warning "pm2 startOrReload ecosystem.config.cjs failed — check pm2 logs"
    fi
  fi

  # Re-start each agent absorbed from snapshot
  if [ -d agents ]; then
    for agent_dir in agents/*/; do
      [ -d "${agent_dir}" ] || continue
      local agent_name
      agent_name=$(basename "${agent_dir}")
      [ -f "${agent_dir}/IDENTITY.md" ] || continue
      pm2 delete "${agent_name}" >/dev/null 2>&1 || true
      if pm2 start dist/index.js --name "${agent_name}" -- --agent "${agent_name}" >/dev/null 2>&1; then
        printf '    agent: %s\n' "${agent_name}"
      else
        print_warning "agent ${agent_name} failed to start — check pm2 logs ${agent_name}"
      fi
    done
    pm2 save >/dev/null 2>&1 || true
  fi

  print_success "PM2 reconcile complete"
}

fetch_metadata() {
  METADATA_FILE="/tmp/neato-hive-current-${UID}.json"
  rm -f "${METADATA_FILE}"
  curl -fsSL "${API_URL}" -o "${METADATA_FILE}"
  if [ ! -s "${METADATA_FILE}" ]; then
    die 1 "release metadata download succeeded but the body was empty."
  fi
}

parse_metadata() {
  local parsed

  parsed=$(node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const version = typeof data.version === "string" ? data.version : "";
const tarball = typeof data.tarball_url === "string" ? data.tarball_url : "";
const checksum = typeof data.checksum_sha256 === "string" ? data.checksum_sha256 : "";
if (!version || !tarball || !checksum) {
  process.exit(1);
}
console.log([version, tarball, checksum].join("\t"));
' "${METADATA_FILE}") || die 1 "release metadata is missing one or more required fields."

  RELEASE_VERSION=$(printf '%s\n' "${parsed}" | awk -F'\t' '{ print $1 }')
  RELEASE_TARBALL_URL=$(printf '%s\n' "${parsed}" | awk -F'\t' '{ print $2 }')
  RELEASE_CHECKSUM=$(printf '%s\n' "${parsed}" | awk -F'\t' '{ print $3 }')

  if ! printf '%s\n' "${RELEASE_CHECKSUM}" | grep -Eq '^[A-Fa-f0-9]{64}$'; then
    die 1 "release metadata checksum is malformed."
  fi
}

download_tarball() {
  TARBALL_FILE="/tmp/neato-hive-v${RELEASE_VERSION}.tar.gz"
  if [ "${RELEASE_TARBALL_URL}" = "file://${TARBALL_FILE}" ]; then
    if [ ! -s "${TARBALL_FILE}" ]; then
      die 1 "fixture tarball '${TARBALL_FILE}' is missing or empty."
    fi
    return 0
  fi

  rm -f "${TARBALL_FILE}"
  curl -fsSL "${RELEASE_TARBALL_URL}" -o "${TARBALL_FILE}"
  if [ ! -s "${TARBALL_FILE}" ]; then
    die 1 "tarball download succeeded but the file is empty."
  fi
}

verify_checksum() {
  local computed=""

  if [ "${SKIP_CHECKSUM}" -eq 1 ]; then
    print_warning "checksum verification disabled via --skip-checksum (testing only)."
    return 0
  fi

  computed=$(compute_sha256 "${TARBALL_FILE}") || return 1

  if [ "${computed}" != "${RELEASE_CHECKSUM}" ]; then
    print_error "checksum mismatch: expected ${RELEASE_CHECKSUM}, got ${computed}"
    return 1
  fi

  print_success "SHA-256 verified"
}

compute_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
    return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
    return 0
  fi

  print_error "no SHA-256 tool found (need shasum or sha256sum)."
  return 1
}

stage_extract() {
  TARGET_PARENT=$(dirname "${TARGET_DIR}")
  STAGING_DIR="${TARGET_DIR}.staging-$$"

  mkdir -p "${TARGET_PARENT}"
  rm -rf "${STAGING_DIR}"
  mkdir -p "${STAGING_DIR}"
  tar -xzf "${TARBALL_FILE}" -C "${STAGING_DIR}"

  if [ ! -d "${STAGING_DIR}/dist-pkg/dist" ] \
    || [ ! -d "${STAGING_DIR}/dist-pkg/bin" ] \
    || [ ! -f "${STAGING_DIR}/dist-pkg/package.json" ] \
    || [ ! -f "${STAGING_DIR}/dist-pkg/pnpm-lock.yaml" ]; then
    die 1 "release tarball contents are invalid; expected dist-pkg/ with dist/, bin/, package.json, pnpm-lock.yaml."
  fi

  print_success "Extracted dist-pkg/ to staging"
}

atomic_swap() {
  if [ -e "${TARGET_DIR}" ]; then
    if [ -d "${TARGET_DIR}" ] && [ -z "$(ls -A "${TARGET_DIR}" 2>/dev/null)" ]; then
      rmdir "${TARGET_DIR}"
    else
      die 1 "target directory '${TARGET_DIR}' already exists and is not empty."
    fi
  fi

  if ! mv "${STAGING_DIR}/dist-pkg" "${TARGET_DIR}"; then
    die 1 "failed to atomically move staging contents into '${TARGET_DIR}'."
  fi

  print_success "Atomic-rename to ${TARGET_DIR}"
}

cleanup_staging_and_tarball() {
  if [ -d "${STAGING_DIR}" ]; then
    rm -rf "${STAGING_DIR}"
  fi
  if [ -f "${TARBALL_FILE}" ]; then
    rm -f "${TARBALL_FILE}"
  fi
  if [ -f "${METADATA_FILE}" ]; then
    rm -f "${METADATA_FILE}"
  fi
  STAGING_DIR=""
  TARBALL_FILE=""
  METADATA_FILE=""
  print_success "Cleanup complete"
}

run_pnpm_install() {
  (
    cd "${TARGET_DIR}"
    pnpm install --frozen-lockfile
  )
  print_success "pnpm install --frozen-lockfile"
}

generate_token() {
  local token

  token=$(openssl rand -hex 32)
  if [ "${#token}" -ne 64 ] || ! printf '%s\n' "${token}" | grep -Eq '^[a-f0-9]{64}$'; then
    die 1 "openssl produced an invalid dashboard token."
  fi

  printf '%s\n' "${token}"
}

write_env() {
  local token=$1

  (
    cd "${TARGET_DIR}"
    printf '\nHIVE_DASHBOARD_TOKEN=%s\n' "${token}" >> .env
  )
  print_success "Wrote .env"
}

mirror_token() {
  local token=$1
  local mirror_file="${TOKEN_MIRROR_DIR}/dashboard-token"

  mkdir -p "${TOKEN_MIRROR_DIR}"
  printf '%s' "${token}" > "${mirror_file}"
  chmod 600 "${mirror_file}"
  print_success "Mirrored token to ${mirror_file}"
}

run_repair_mode() {
  local parsed=""
  local extract_dir=""
  local extracted_hive=""
  local backup_path=""
  local ts=""
  local download_ok=0
  local attempt=0

  print_step "Repair mode — refreshing bin/hive only"

  if [ ! -f "${TARGET_DIR}/bin/hive" ]; then
    die 1 "no existing hive install at ${TARGET_DIR} — run install.sh without --repair to do a fresh install."
  fi
  if ! command -v jq >/dev/null 2>&1; then
    die 1 "jq is required for --repair but was not found."
  fi

  METADATA_FILE=$(mktemp "/tmp/neato-hive-repair-metadata.XXXXXX.json")
  curl -fsSL "${API_URL}" -o "${METADATA_FILE}" || die 1 "failed to download release metadata from ${API_URL}."
  if [ ! -s "${METADATA_FILE}" ]; then
    die 1 "release metadata download succeeded but the body was empty."
  fi

  parsed=$(jq -er '
    if (.version | type) == "string" and (.version | length) > 0
      and (.tarball_url | type) == "string" and (.tarball_url | length) > 0
      and (.checksum_sha256 | type) == "string" and (.checksum_sha256 | length) > 0
    then [.version, .tarball_url, .checksum_sha256] | @tsv
    else empty
    end
  ' "${METADATA_FILE}") || die 1 "release metadata is missing one or more required fields."

  RELEASE_VERSION=$(printf '%s\n' "${parsed}" | awk -F'\t' '{ print $1 }')
  RELEASE_TARBALL_URL=$(printf '%s\n' "${parsed}" | awk -F'\t' '{ print $2 }')
  RELEASE_CHECKSUM=$(printf '%s\n' "${parsed}" | awk -F'\t' '{ print $3 }')

  if ! printf '%s\n' "${RELEASE_CHECKSUM}" | grep -Eq '^[A-Fa-f0-9]{64}$'; then
    die 1 "release metadata checksum is malformed."
  fi

  STAGING_DIR=$(mktemp -d "/tmp/neato-hive-repair.XXXXXX")
  TARBALL_FILE="${STAGING_DIR}/release.tar.gz"
  extract_dir="${STAGING_DIR}/extract"
  mkdir -p "${extract_dir}"

  if [ "${RELEASE_TARBALL_URL}" = "file://${TARBALL_FILE}" ]; then
    if [ ! -s "${TARBALL_FILE}" ]; then
      die 1 "fixture tarball '${TARBALL_FILE}' is missing or empty."
    fi
    download_ok=1
  else
    rm -f "${TARBALL_FILE}"
    for attempt in 1 2; do
      if curl -fsSL "${RELEASE_TARBALL_URL}" -o "${TARBALL_FILE}"; then
        download_ok=1
        break
      fi
      print_warning "tarball download failed (attempt ${attempt}/2)"
    done
  fi
  if [ "${download_ok}" -ne 1 ] || [ ! -s "${TARBALL_FILE}" ]; then
    die 1 "failed to download release tarball from ${RELEASE_TARBALL_URL}."
  fi

  verify_checksum || die 1 "checksum verification failed."

  if tar -tzf "${TARBALL_FILE}" "bin/hive" >/dev/null 2>&1; then
    tar -xzf "${TARBALL_FILE}" -C "${extract_dir}" "bin/hive" || die 1 "failed to extract bin/hive from release tarball."
    extracted_hive="${extract_dir}/bin/hive"
  elif tar -tzf "${TARBALL_FILE}" "dist-pkg/bin/hive" >/dev/null 2>&1; then
    tar -xzf "${TARBALL_FILE}" -C "${extract_dir}" "dist-pkg/bin/hive" || die 1 "failed to extract bin/hive from release tarball."
    extracted_hive="${extract_dir}/dist-pkg/bin/hive"
  else
    die 1 "release tarball does not contain bin/hive."
  fi

  if [ ! -f "${extracted_hive}" ]; then
    die 1 "release tarball is missing bin/hive after extraction."
  fi

  ts=$(date -u +%Y%m%dT%H%M%SZ)
  backup_path="${TARGET_DIR}/bin.repair-backup-${ts}"
  cp -R "${TARGET_DIR}/bin" "${backup_path}" || die 1 "failed to back up existing bin/ directory."

  if ! cp "${extracted_hive}" "${TARGET_DIR}/bin/hive"; then
    cp "${backup_path}/hive" "${TARGET_DIR}/bin/hive" || true
    die 1 "failed to replace bin/hive."
  fi
  if ! chmod +x "${TARGET_DIR}/bin/hive"; then
    cp "${backup_path}/hive" "${TARGET_DIR}/bin/hive" || true
    die 1 "failed to make repaired bin/hive executable."
  fi

  # Keep the 5 most recent bin.repair-backup-* directories, prune older.
  # Uses ls -t (sort by mtime, newest first) and tail to skip the first 5.
  ls -1dt "${TARGET_DIR}"/bin.repair-backup-* 2>/dev/null | tail -n +6 | while read -r old_backup; do
    rm -rf "${old_backup}" 2>/dev/null || true
  done

  printf '\n'
  printf '✓ Refreshed bin/hive to v%s\n' "${RELEASE_VERSION}"
  printf '  Backup of previous: %s/\n' "${backup_path}"
  printf '\n'
  printf 'Now run: hive update\n'
  exit 0
}

start_dashboard_services() {
  (
    cd "${TARGET_DIR}"
    if [ -f ecosystem.config.cjs ] && pm2 startOrReload ecosystem.config.cjs --update-env >/dev/null 2>&1; then
      pm2 save >/dev/null 2>&1 || true
      print_success "Started hive-runner + hive-dashboard"
    else
      print_warning "pm2 startOrReload ecosystem.config.cjs failed — check pm2 logs"
    fi
  )
}

run_tailscale_expose() {
  local helper="${TARGET_DIR}/scripts/tailscale-expose.sh"
  local output=""

  if [ ! -x "${helper}" ]; then
    print_warning "tailscale expose helper missing — dashboard remains local-only at http://localhost:7777"
    INSTALL_DASHBOARD_URL="http://localhost:7777"
    return 0
  fi

  output=$("${helper}" 2>&1 || true)
  if [ -n "${output}" ]; then
    while IFS= read -r line; do
      [ -n "${line}" ] || continue
      printf '    %s\n' "${line}"
    done <<EOF
${output}
EOF
  fi

  INSTALL_DASHBOARD_URL=$(printf '%s\n' "${output}" | grep -Eo 'https://[^ ]+' | tail -n1 || true)
  if [ -z "${INSTALL_DASHBOARD_URL}" ]; then
    INSTALL_DASHBOARD_URL="http://localhost:7777"
  fi
}

print_success_block() {
  local token=$1
  local dashboard_url=${2:-http://localhost:7777}

  printf '\n'
  print_step "✓ Install complete!"
  printf '\n'
  printf 'Next steps to start Hive:\n\n'
  printf '  cd %s\n' "${TARGET_DIR}"
  printf '  pm2 startOrReload ecosystem.config.cjs\n'
  printf '  pm2 save\n'
  printf '\n'
  printf 'Then visit the dashboard at:\n\n'
  printf '  %s\n' "${dashboard_url}"
  if [ "${dashboard_url}" != "http://localhost:7777" ]; then
    printf '  http://localhost:7777\n'
  fi
  printf '\n'
  printf "Dashboard auth is off by default. If you later set DASHBOARD_REQUIRE_AUTH=true, use this token:\n\n"
  printf '  %s\n' "${token}"
  printf '\n'
  printf 'Token also saved at: %s/dashboard-token\n' "${TOKEN_MIRROR_DIR}"
  printf '\n'
  printf 'For setup beyond the dashboard (Discord bot, agents, Claude CLI):\n\n'
  printf '  cd %s\n' "${TARGET_DIR}"
  printf '  ./setup.sh --post-install\n'
  printf '\n'
  printf '(setup.sh auto-detects the post-install state; --post-install is the explicit form.)\n'
  printf '\n'
  printf 'Spec / docs: https://github.com/anthonyconnelly/neato-hive\n'
}

print_banner() {
  printf '%s==> Neato Hive Installer (v%s)%s\n\n' "$(color bold)" "${SCRIPT_VERSION}" "$(color reset)"
}

print_platform_status() {
  case "${OS_NAME}" in
    darwin)
      print_success "macOS (darwin)"
      print_success "Homebrew installed"
      ;;
    linux)
      print_success "Ubuntu Linux (linux)"
      print_success "${PACKAGE_MANAGER} available"
      ;;
  esac
}

main() {
  local token=""

  parse_args "$@"
  print_banner
  if [ "${REPAIR_MODE}" = "1" ]; then
    run_repair_mode
  fi
  detect_os
  detect_package_manager
  if [ "${ACKNOWLEDGED_AUTO_INSTALL}" -eq 1 ]; then
    :
  fi
  print_platform_status

  # v1.5.15 — classify existing install and branch:
  #   fresh  → standard install (continues below)
  #   modern → refuse re-install, point user to `hive update`
  #            (unless --migrate or --fresh forces override)
  #   legacy → absorb mode (snapshot existing, fresh-install, absorb state)
  local classification
  classification=$(classify_existing_install)

  if [ "${FORCE_FRESH}" -eq 1 ] && [ "${classification}" != "fresh" ]; then
    # User explicitly asked to wipe an existing install.
    local existing_ver
    existing_ver=$(get_existing_install_version)
    print_warning "--fresh requested; existing v${existing_ver} install will be removed (no absorb)."
    local ts wipe_dir
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    wipe_dir="${TARGET_DIR}.wiped-${ts}"
    mv "${TARGET_DIR}" "${wipe_dir}"
    print_success "Existing install moved to ${wipe_dir} (delete manually when comfortable)"
    classification="fresh"
  elif [ "${FORCE_MIGRATE}" -eq 1 ] && [ "${classification}" = "modern" ]; then
    # User explicitly asked to re-baseline a modern install.
    print_warning "--migrate requested on modern install — running absorb-mode anyway"
    classification="legacy"
  fi

  case "${classification}" in
    fresh)
      ;;
    modern)
      print_modern_install_message "$(get_existing_install_version)"
      ;;
    legacy)
      # Need release metadata + prereqs + tarball before we can run absorb.
      collect_prereq_state
      if [ "${MODE}" = "check-only" ]; then
        show_prereq_report
        if has_prereq_failures; then
          print_error "dry run blocked: one or more prereqs are missing or too old."
          exit 1
        fi
        printf '\n'
        print_success "Legacy install at ${TARGET_DIR} (v$(get_existing_install_version))"
        print_success "ready to run --migrate (snapshot + fresh + absorb)"
        exit 0
      fi
      if [ "${MODE}" = "no-install-prereqs" ]; then
        show_prereq_report
        if has_prereq_failures; then
          die 1 "missing prereqs detected and --no-install-prereqs was requested."
        fi
      else
        show_prereq_report
        if has_prereq_failures && ! install_missing_prereqs; then
          die 1 "one or more prereqs could not be satisfied."
        fi
      fi
      collect_prereq_state
      if has_prereq_failures; then
        die 1 "one or more prereqs remain unsatisfied after verification."
      fi
      print_step "Fetching release metadata from ${API_URL}"
      fetch_metadata
      parse_metadata
      printf '  Latest version: %s\n' "${RELEASE_VERSION}"
      printf '  Tarball:        %s\n' "${RELEASE_TARBALL_URL}"
      printf '  Checksum:       %s\n' "${RELEASE_CHECKSUM}"
      printf '\n'
      print_step "Downloading tarball"
      download_tarball
      print_success "Saved to ${TARBALL_FILE}"
      verify_checksum || die 1 "checksum verification failed."
      run_legacy_absorb_flow "$(get_existing_install_version)"
      ;;
  esac

  collect_prereq_state

  if [ "${MODE}" = "check-only" ]; then
    show_prereq_report
    if has_prereq_failures; then
      print_error "dry run blocked: one or more prereqs are missing or too old."
      exit 1
    fi
    print_success "ready to install into ${TARGET_DIR}"
    exit 0
  fi

  if [ "${MODE}" = "no-install-prereqs" ]; then
    show_prereq_report
    if has_prereq_failures; then
      die 1 "missing prereqs detected and --no-install-prereqs was requested."
    fi
  else
    show_prereq_report
    if has_prereq_failures && ! install_missing_prereqs; then
      die 1 "one or more prereqs could not be satisfied."
    fi
  fi

  collect_prereq_state
  if has_prereq_failures; then
    die 1 "one or more prereqs remain unsatisfied after verification."
  fi

  print_step "Fetching release metadata from ${API_URL}"
  fetch_metadata
  parse_metadata
  printf '  Latest version: %s\n' "${RELEASE_VERSION}"
  printf '  Tarball:        %s\n' "${RELEASE_TARBALL_URL}"
  printf '  Checksum:       %s\n' "${RELEASE_CHECKSUM}"

  printf '\n'
  print_step "Downloading tarball"
  download_tarball
  print_success "Saved to ${TARBALL_FILE}"
  verify_checksum || die 1 "checksum verification failed."

  printf '\n'
  print_step "Extracting to ${TARGET_DIR}"
  stage_extract
  atomic_swap
  cleanup_staging_and_tarball

  printf '\n'
  print_step "Post-install setup"
  run_pnpm_install
  # Match `hive update`'s post-overlay runtime-prereq pass here so a fresh
  # curl-bash install does not depend on setup.sh step 2 completing later.
  install_runtime_prereqs
  token=$(generate_token)
  print_success "Generated dashboard token"
  write_env "${token}"
  mirror_token "${token}"
  start_dashboard_services
  printf '\n'
  # Dashboard exposure is opt-in: remote access via Tailscale Serve should
  # only happen on an explicit yes from an interactive operator.
  if [ -t 0 ] && [ -t 1 ]; then
    printf "Expose the dashboard via Tailscale Serve (HTTPS) so other tailnet devices can reach it? [y/N] "
    read -r expose_reply
    case "${expose_reply}" in
      [yY]|[yY][eE][sS])
        run_tailscale_expose
        ;;
      *)
        echo "Skipped. To enable later, run: hive doctor --fix-tailscale"
        ;;
    esac
  else
    echo "Non-interactive install detected. Dashboard remote access via Tailscale Serve is NOT enabled by default."
    echo "To enable later: tailscale serve --bg --https=443 http://localhost:7777"
    echo "  OR: hive doctor --fix-tailscale"
  fi
  print_success_block "${token}" "${INSTALL_DASHBOARD_URL}"
}

main "$@"

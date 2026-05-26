#!/usr/bin/env bash
set -euo pipefail

#-----------------------------------------------------------------------
# scripts/install-prereqs.sh — Detect and (optionally) install Neato
# Hive's six prereqs: node (≥ 18), pnpm, pm2, git, curl, tar.
#
# Usage:  bash scripts/install-prereqs.sh [--check-only|--install|--auto] [--json] [--help]
#
# Default mode: --check-only (no installs, just detect-and-report).
#
# v1.5.0 F.1 — Spec: docs/v1.5.0-tasks/F.1-install-prereqs.md
# Consumers: F.2 install.sh fresh-install flow; F.3 setup-wizard integration.
#-----------------------------------------------------------------------

MIN_NODE_MAJOR=18
MIN_NODE_VERSION="18.0.0"
MODE="check-only"
JSON_MODE=0
USE_COLOR=0
OS_NAME=""
PACKAGE_MANAGER=""
PREREQS=(node pnpm pm2 git curl tar)

SATISFIED=()
FOUND_VERSIONS=()
INSTALL_COMMANDS=()
DETAILS=()

if [ -t 1 ]; then
  USE_COLOR=1
fi

usage() {
  cat <<'EOF'
Usage: bash scripts/install-prereqs.sh [--check-only|--install|--auto] [--json] [--help]

Modes (mutually exclusive — pick at most one; default is --check-only):
  --check-only    Detect prereqs and report. Do NOT install. (default)
  --install       Detect prereqs. For each missing, prompt y/N and install if confirmed.
  --auto          Detect prereqs. Install all missing without prompting.

Output:
  --json          Emit machine-readable JSON instead of human-readable text.
                  Compatible with --check-only, --install, --auto modes (in install
                  modes, JSON is emitted only after the run completes).

  --help          Print this usage text and exit 0.

Exit codes:
  0 — all prereqs satisfied
  1 — one or more prereqs missing AND not installed (e.g. --check-only with missing prereqs)
  2 — bad arguments / unsupported OS / Homebrew missing on macOS
EOF
}

error() {
  printf "ERROR: %s\n" "$*" >&2
}

json_escape() {
  local value
  value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  printf '%s' "${value}"
}

json_string_or_null() {
  if [ -z "${1}" ]; then
    printf 'null'
  else
    printf '"%s"' "$(json_escape "$1")"
  fi
}

symbol_ok() {
  if [ "${USE_COLOR}" -eq 1 ]; then
    printf '\033[32m✓\033[0m'
  else
    printf '✓'
  fi
}

symbol_bad() {
  if [ "${USE_COLOR}" -eq 1 ]; then
    printf '\033[31m✗\033[0m'
  else
    printf '✗'
  fi
}

print_line() {
  if [ "${JSON_MODE}" -eq 1 ]; then
    return
  fi

  printf '%s\n' "$*"
}

detect_os() {
  local forced uname_value

  forced=${HIVE_INSTALL_PREREQS_FORCE_OS:-}
  if [ -n "${forced}" ]; then
    case "${forced}" in
      darwin|linux)
        printf '%s\n' "${forced}"
        return 0
        ;;
      *)
        error "unsupported OS override '${forced}'."
        exit 2
        ;;
    esac
  fi

  uname_value=$(uname)
  case "${uname_value}" in
    Darwin)
      printf 'darwin\n'
      ;;
    Linux)
      printf 'linux\n'
      ;;
    *)
      error "unsupported OS '${uname_value}'. Neato Hive supports macOS and Ubuntu Linux."
      exit 2
      ;;
  esac
}

detect_package_manager() {
  case "$1" in
    darwin)
      printf 'brew\n'
      ;;
    linux)
      if command -v apt-get >/dev/null 2>&1; then
        printf 'apt-get\n'
        return 0
      fi
      error "unsupported Linux host: apt-get not found. Neato Hive supports Ubuntu Linux."
      exit 2
      ;;
    *)
      error "unsupported OS '$1'. Neato Hive supports macOS and Ubuntu Linux."
      exit 2
      ;;
  esac
}

check_command_version() {
  local command_name version_line

  command_name=$1
  shift
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    return 1
  fi

  version_line=$("$@" 2>/dev/null | head -1) || version_line=""
  printf '%s\n' "${version_line}"
  return 0
}

_check_node() {
  local raw version major

  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi

  raw=$(node --version 2>/dev/null) || raw=""
  version=${raw#v}
  printf '%s\n' "${version}"
  major=$(printf '%s\n' "${version}" | awk -F. 'NF { print $1 }')
  if [ -z "${major}" ] || [ "${major}" -lt "${MIN_NODE_MAJOR}" ]; then
    printf "Node %s is too old; need ≥ %s. Upgrade manually via brew (\`brew upgrade node\`) or NodeSource (\`https://github.com/nodesource/distributions\`).\n" "${version}" "${MIN_NODE_VERSION}" >&3
    return 1
  fi

  return 0
}

_check_pnpm() {
  check_command_version pnpm pnpm --version
}

_check_pm2() {
  check_command_version pm2 pm2 --version
}

_check_git() {
  local version_line

  version_line=$(check_command_version git git --version) || return 1
  printf '%s\n' "${version_line}" | awk '{print $3}'
}

_check_curl() {
  local version_line

  version_line=$(check_command_version curl curl --version) || return 1
  printf '%s\n' "${version_line}" | awk '{print $2}'
}

_check_tar() {
  local version_line

  version_line=$(check_command_version tar tar --version) || return 1
  printf '%s\n' "${version_line}" | awk 'NF { print $1 " " $2 }'
}

_install_command_for() {
  local name os prefix

  name=$1
  os=$2
  prefix=""
  if [ "${os}" = "linux" ] && [ "$(id -u)" -ne 0 ]; then
    prefix="sudo "
  fi

  case "${name}:${os}" in
    node:darwin)
      printf 'brew install node\n'
      ;;
    node:linux)
      printf '%sapt-get install -y nodejs npm\n' "${prefix}"
      ;;
    pnpm:darwin|pnpm:linux)
      printf 'npm install -g pnpm\n'
      ;;
    pm2:darwin|pm2:linux)
      printf 'npm install -g pm2\n'
      ;;
    git:darwin)
      printf 'brew install git\n'
      ;;
    git:linux)
      printf '%sapt-get install -y git\n' "${prefix}"
      ;;
    curl:darwin)
      printf 'brew install curl\n'
      ;;
    curl:linux)
      printf '%sapt-get install -y curl\n' "${prefix}"
      ;;
    tar:darwin)
      printf ''
      ;;
    tar:linux)
      printf '%sapt-get install -y tar\n' "${prefix}"
      ;;
    *)
      printf ''
      ;;
  esac
}

run_install() {
  local name os command_text

  name=$1
  os=$2
  command_text=$(_install_command_for "${name}" "${os}")

  if [ -z "${command_text}" ]; then
    return 1
  fi

  if [ "${JSON_MODE}" -eq 1 ]; then
    printf '==> Running: %s\n' "${command_text}" >&2
  else
    printf '==> Running: %s\n' "${command_text}"
  fi

  case "${name}:${os}" in
    node:darwin)
      run_install_command brew install node
      ;;
    node:linux)
      if [ "$(id -u)" -eq 0 ]; then
        run_install_command apt-get install -y nodejs npm
      else
        run_install_command sudo apt-get install -y nodejs npm
      fi
      ;;
    pnpm:darwin|pnpm:linux)
      run_install_command npm install -g pnpm
      ;;
    pm2:darwin|pm2:linux)
      run_install_command npm install -g pm2
      ;;
    git:darwin)
      run_install_command brew install git
      ;;
    git:linux)
      if [ "$(id -u)" -eq 0 ]; then
        run_install_command apt-get install -y git
      else
        run_install_command sudo apt-get install -y git
      fi
      ;;
    curl:darwin)
      run_install_command brew install curl
      ;;
    curl:linux)
      if [ "$(id -u)" -eq 0 ]; then
        run_install_command apt-get install -y curl
      else
        run_install_command sudo apt-get install -y curl
      fi
      ;;
    tar:linux)
      if [ "$(id -u)" -eq 0 ]; then
        run_install_command apt-get install -y tar
      else
        run_install_command sudo apt-get install -y tar
      fi
      ;;
    *)
      return 1
      ;;
  esac
}

run_install_command() {
  if [ "${JSON_MODE}" -eq 1 ]; then
    "$@" >&2
  else
    "$@"
  fi
}

capture_check() {
  local name version_file detail_file version detail status install_command

  name=$1
  version_file=$(mktemp)
  detail_file=$(mktemp)
  install_command=$(_install_command_for "${name}" "${OS_NAME}")
  if "_check_${name}" >"${version_file}" 3>"${detail_file}"; then
    status=1
  else
    status=0
  fi

  version=$(cat "${version_file}")
  detail=$(cat "${detail_file}")
  rm -f "${version_file}" "${detail_file}"

  if [ "${status}" -eq 1 ]; then
    install_command=""
  elif [ "${name}" = "node" ] && [ -n "${detail}" ]; then
    install_command=""
  elif [ "${name}" = "tar" ] && [ "${OS_NAME}" = "darwin" ]; then
    install_command=""
  fi

  SATISFIED+=("${status}")
  FOUND_VERSIONS+=("${version}")
  INSTALL_COMMANDS+=("${install_command}")
  DETAILS+=("${detail}")
}

print_report() {
  local satisfied_count i name version status detail install_command symbol suffix

  satisfied_count=0
  print_line "Checking required tools for Neato Hive install..."
  print_line ""

  for i in "${!PREREQS[@]}"; do
    name=${PREREQS[$i]}
    version=${FOUND_VERSIONS[$i]}
    status=${SATISFIED[$i]}
    detail=${DETAILS[$i]}
    install_command=${INSTALL_COMMANDS[$i]}

    if [ "${status}" -eq 1 ]; then
      symbol=$(symbol_ok)
      suffix=""
      if [ "${name}" = "node" ]; then
        suffix="    (≥ ${MIN_NODE_VERSION})"
      fi
      printf '  %s %-7s %s%s\n' "${symbol}" "${name}" "${version}" "${suffix}"
      satisfied_count=$((satisfied_count + 1))
      continue
    fi

    symbol=$(symbol_bad)
    if [ -n "${detail}" ]; then
      printf '  %s %-7s %s\n' "${symbol}" "${name}" "${detail}"
    elif [ -n "${install_command}" ]; then
      printf '  %s %-7s NOT INSTALLED — install with: %s\n' "${symbol}" "${name}" "${install_command}"
    else
      printf '  %s %-7s NOT INSTALLED\n' "${symbol}" "${name}"
    fi
  done

  print_line ""
  if [ "${satisfied_count}" -eq "${#PREREQS[@]}" ]; then
    print_line "All 6 prereqs satisfied."
  else
    printf '%s of %s prereqs satisfied. %s missing.\n' \
      "${satisfied_count}" "${#PREREQS[@]}" "$(( ${#PREREQS[@]} - satisfied_count ))"
    print_line ""
    if [ "${MODE}" = "check-only" ]; then
      print_line "Run \`bash scripts/install-prereqs.sh --install\` to install missing prereqs interactively."
      print_line "Run \`bash scripts/install-prereqs.sh --auto\` to install missing prereqs unattended."
    fi
  fi
}

emit_json() {
  local ts all_satisfied i name

  if all_satisfied; then
    all_satisfied=true
  else
    all_satisfied=false
  fi

  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  printf '{'
  printf '"version":"1",'
  printf '"ts":"%s",' "${ts}"
  printf '"os":"%s",' "${OS_NAME}"
  printf '"package_manager":"%s",' "${PACKAGE_MANAGER}"
  printf '"all_satisfied":%s,' "${all_satisfied}"
  printf '"prereqs":['
  for i in "${!PREREQS[@]}"; do
    name=${PREREQS[$i]}
    [ "${i}" -gt 0 ] && printf ','
    printf '{'
    printf '"name":"%s",' "${name}"
    if [ "${SATISFIED[$i]}" -eq 1 ]; then
      printf '"satisfied":true,'
    else
      printf '"satisfied":false,'
    fi
    printf '"found_version":'
    json_string_or_null "${FOUND_VERSIONS[$i]}"
    printf ','
    printf '"min_version":'
    if [ "${name}" = "node" ]; then
      json_string_or_null "${MIN_NODE_VERSION}"
    else
      printf 'null'
    fi
    printf ','
    printf '"install_command":'
    json_string_or_null "${INSTALL_COMMANDS[$i]}"
    printf '}'
  done
  printf ']}\n'
}

all_satisfied() {
  local i

  for i in "${!PREREQS[@]}"; do
    if [ "${SATISFIED[$i]}" -ne 1 ]; then
      return 1
    fi
  done

  return 0
}

parse_args() {
  local requested_mode arg

  requested_mode=""
  for arg in "$@"; do
    case "${arg}" in
      --check-only|--install|--auto)
        if [ -n "${requested_mode}" ] && [ "${requested_mode}" != "${arg#--}" ]; then
          error "--${requested_mode} and ${arg} are mutually exclusive"
          exit 2
        fi
        requested_mode=${arg#--}
        ;;
      --json)
        JSON_MODE=1
        ;;
      --help)
        usage
        exit 0
        ;;
      *)
        error "unknown argument '${arg}'"
        exit 2
        ;;
    esac
  done

  if [ -n "${requested_mode}" ]; then
    MODE=${requested_mode}
  fi
}

install_missing_prereqs() {
  local i name command_text answer version_file

  for i in "${!PREREQS[@]}"; do
    if [ "${SATISFIED[$i]}" -eq 1 ]; then
      continue
    fi

    name=${PREREQS[$i]}
    command_text=${INSTALL_COMMANDS[$i]}

    if [ -z "${command_text}" ]; then
      continue
    fi

    if [ "${MODE}" = "install" ]; then
      if [ "${JSON_MODE}" -eq 1 ]; then
        printf "Install %s via \`%s\`? [y/N]: " "${name}" "${command_text}" >&2
      else
        printf "Install %s via \`%s\`? [y/N]: " "${name}" "${command_text}"
      fi
      IFS= read -r answer
      case "${answer}" in
        y|Y|yes|YES)
          ;;
        *)
          continue
          ;;
      esac
    fi

    if ! run_install "${name}" "${OS_NAME}"; then
      if [ "${JSON_MODE}" -eq 1 ]; then
        printf '✗ %s install failed.\n' "${name}" >&2
      else
        printf '✗ %s install failed.\n' "${name}"
      fi
      continue
    fi

    version_file=$(mktemp)
    if "_check_${name}" >"${version_file}" 3>/dev/null; then
      FOUND_VERSIONS[i]=$(cat "${version_file}")
      SATISFIED[i]=1
      INSTALL_COMMANDS[i]=""
      DETAILS[i]=""
      if [ "${JSON_MODE}" -eq 1 ]; then
        printf '✓ %s installed: %s\n' "${name}" "${FOUND_VERSIONS[$i]}" >&2
      else
        printf '✓ %s installed: %s\n' "${name}" "${FOUND_VERSIONS[$i]}"
      fi
    else
      if [ "${JSON_MODE}" -eq 1 ]; then
        printf '✗ %s install failed.\n' "${name}" >&2
      else
        printf '✗ %s install failed.\n' "${name}"
      fi
    fi
    rm -f "${version_file}"
  done
}

parse_args "$@"
OS_NAME=$(detect_os)
PACKAGE_MANAGER=$(detect_package_manager "${OS_NAME}")

if [ "${OS_NAME}" = "darwin" ] && ! command -v brew >/dev/null 2>&1; then
  error "Homebrew is required on macOS. Install it manually with:"
  # shellcheck disable=SC2016
  error '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  exit 2
fi

for prereq in "${PREREQS[@]}"; do
  capture_check "${prereq}"
done

if [ "${MODE}" != "check-only" ]; then
  install_missing_prereqs
fi

if [ "${JSON_MODE}" -eq 1 ]; then
  emit_json
else
  print_report
fi

if all_satisfied; then
  exit 0
fi

exit 1

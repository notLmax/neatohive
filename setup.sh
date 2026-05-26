#!/bin/bash

# ============================================================
#  Neato Hive — Setup Wizard
#  Sets up your personal AI agent runtime.
# ============================================================

set -e

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

print_header() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}${BOLD}         🐝  Neato Hive Setup  🐝         ${NC}${CYAN}║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
    echo ""
}

print_step() {
    echo ""
    echo -e "${BOLD}━━━ Step $1: $2 ━━━${NC}"
    echo ""
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

prompt_continue() {
    echo ""
    read -p "Press Enter when you've finished the steps above..."
}

# Upsert a key=value pair into .env (in pwd). Creates the file if absent,
# replaces the key in-place if present, appends if the key is new.
# Uses awk to avoid sed metacharacter quoting issues with special values.
env_upsert() {
    local key="$1"
    local value="$2"
    local file=".env"
    if [ ! -f "$file" ]; then
        printf '%s=%s\n' "$key" "$value" > "$file"
        return 0
    fi
    # Use awk to upsert; pass value via env var so awk gets it raw, no quoting hell.
    UPSERT_KEY="$key" UPSERT_VAL="$value" awk '
        BEGIN { found = 0 }
        {
            if ($0 ~ "^" ENVIRON["UPSERT_KEY"] "=") {
                print ENVIRON["UPSERT_KEY"] "=" ENVIRON["UPSERT_VAL"]
                found = 1
            } else {
                print
            }
        }
        END {
            if (!found) print ENVIRON["UPSERT_KEY"] "=" ENVIRON["UPSERT_VAL"]
        }
    ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
}

# Escape-hatch footer — shown under prompts where the user is doing
# external work (browser OAuth, copy-paste from dashboards). Tells them
# Ctrl-C is safe and points to --resume + Parsec pkill workaround.
print_escape_footer() {
    echo -e "${DIM}(Stuck? Ctrl-C to pause — progress saved. Resume with: ./setup.sh --resume${NC}"
    echo -e "${DIM} On Parsec/restricted keyboard: open a new tab and run 'pkill -f setup.sh'.)${NC}"
    echo ""
}

# J.1.0.6 — materialize House MD agent from template on fresh install.
#
# Why: v1.5.0 tarball installs do NOT ship `agents/` (PRESERVE_LIST design —
# user agent customizations must survive `hive update`). House MD's behavior
# files live in `templates/house-md/` as the factory default. This function
# copies the template to `agents/house-md/` on first run so PM2 can start
# the agent in Step 10.
#
# Idempotency: skip if `agents/house-md/IDENTITY.md` already exists. Safe
# on `--resume` re-runs and safe if the user already populated agents/
# manually (e.g. an upgrader from v1.4.x where agents/house-md/ was
# git-tracked at install time).
#
# Failure mode: if templates/house-md/ is missing (packaging defect),
# print clear error and return 1.
materialize_house_md() {
    if [ -f agents/house-md/IDENTITY.md ]; then
        print_success "House MD agent files already present (skipping materialize)"
        return 0
    fi

    if [ ! -d templates/house-md ]; then
        print_error "templates/house-md/ missing from this install."
        echo "  Expected at: $(pwd)/templates/house-md/"
        echo "  This is a packaging defect. Fix:"
        echo "    1. Verify the install completed cleanly: ls $(pwd)/templates"
        echo "    2. If templates/ is incomplete, re-run: curl -fsSL https://neato-hive-site.vercel.app/install.sh | bash"
        echo "    3. If problem persists, report at: https://github.com/anthonyconnelly/neato-hive/issues"
        return 1
    fi

    echo "Materializing House MD from templates/house-md/..."
    mkdir -p agents
    cp -R templates/house-md agents/house-md

    if [ ! -f agents/house-md/IDENTITY.md ]; then
        print_error "House MD materialize failed — agents/house-md/IDENTITY.md absent after cp."
        return 1
    fi

    print_success "House MD agent files materialized at agents/house-md/"
    return 0
}

# F.3 — detect post-fresh-install state. Returns one of:
#   post_fresh_install — install.sh F.2 wrote .env's HIVE_DASHBOARD_TOKEN; setup.sh
#                        hasn't run yet (.setup-state absent).
#   post_v15_migration — C.7 migration handler set the v1_5_0_completed marker
#                        (user upgraded from v1.4.x via `hive update`).
#   fresh              — neither signal; clean wizard run.
detect_post_install_state() {
    local install_root token_present setup_state_present marker_present
    install_root="${HIVE_INSTALL_ROOT:-$(pwd)}"
    token_present=0
    setup_state_present=0
    marker_present=0

    if [ -f "${install_root}/.env" ] && grep -qE '^HIVE_DASHBOARD_TOKEN=' "${install_root}/.env" 2>/dev/null; then
        token_present=1
    fi
    if [ -f "${install_root}/.setup-state" ]; then
        setup_state_present=1
    fi
    if [ -f "${HIVE_STATE_ROOT:-$HOME/.neato-hive}/migrations/v1_5_0_completed" ]; then
        marker_present=1
    fi

    if [ "${token_present}" -eq 1 ] && [ "${setup_state_present}" -eq 0 ]; then
        echo "post_fresh_install"
        return
    fi
    if [ "${marker_present}" -eq 1 ]; then
        echo "post_v15_migration"
        return
    fi
    echo "fresh"
}

# Opening screen — shown once on fresh runs before Step 1.
# Explains what the wizard does, time estimate, required accounts,
# and how to exit cleanly.
print_opening() {
    local state="${POST_INSTALL_STATE:-fresh}"

    case "${state}" in
        post_fresh_install)
            echo -e "${BOLD}━━━ Detected fresh install ━━━${NC}"
            echo ""
            echo "Welcome — install.sh just set up the dashboard. Let's finish the wizard:"
            echo "  • Discord bot creation"
            echo "  • Claude Code authentication"
            echo "  • Your first agent (House MD) bootstrapping"
            echo ""
            echo "Time: ~10 minutes. Skip-able prereq steps will auto-skip (already-installed)."
            echo ""
            ;;
        post_v15_migration)
            echo -e "${BOLD}━━━ Detected v1.5.0 install (migrated from v1.4.x) ━━━${NC}"
            echo ""
            echo "Continuing wizard for any new setup steps."
            echo ""
            ;;
        *)
            echo -e "${BOLD}━━━ Before we start ━━━${NC}"
            echo ""
            echo "You're about to install Neato Hive — your personal AI agent runtime."
            echo "When this is done, you'll have:"
            echo "  • A Discord server where you chat with your agents"
            echo "  • House MD — your first agent, who builds all future agents for you"
            echo "  • Everything running on your Mac, auto-starting on login"
            echo ""
            echo "Time: ~10 minutes for the wizard, plus ~15 minutes of Discord bot creation"
            echo "You'll need:"
            echo "  • A Claude Max subscription (5x or 20x)"
            echo "  • A Discord account + your own server (or admin rights on one)"
            echo "  • Your Discord User ID ready to paste"
            echo ""
            echo "At any point:"
            ;;
    esac

    echo -e "  • Press ${CYAN}Ctrl-C${NC} to pause. Your progress is saved."
    echo -e "  • Run ${CYAN}./setup.sh --resume${NC} to continue where you left off."
    echo -e "  • Run ${CYAN}./setup.sh --fresh${NC} to start over."
    echo ""
    echo -e "  ${DIM}On Parsec? Ctrl-C may be remapped. From a new terminal tab:${NC}"
    echo -e "    ${CYAN}pkill -f setup.sh${NC}"
    echo ""
    read -p "Press Enter to begin, or Ctrl-C to exit… "
    echo ""
}

# Pre-flight check — runs on every invocation before any wizard steps.
# Auto-verifies hard system prereqs (OS, Node, Homebrew, Claude CLI, Git,
# GitHub repo access). Confirms account prereqs that can't be auto-checked
# (Max subscription, Discord server, User ID). Exits on hard failure with
# the exact install command so the user never has to go searching.
run_preflight() {
    echo -e "${BOLD}━━━ Pre-flight Check ━━━${NC}"
    echo ""
    echo "Checking system requirements..."
    echo ""

    local PREFLIGHT_OK=true

    # OS check
    if [[ "$OSTYPE" == "darwin"* ]]; then
        print_success "macOS detected"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        print_success "Linux detected"
    else
        print_error "Hive requires macOS or Linux. OS '$OSTYPE' not supported."
        echo "  (Windows Subsystem for Linux is untested.)"
        PREFLIGHT_OK=false
    fi

    # Node.js 18+ (Claude Code's own requirement)
    if command -v node &>/dev/null; then
        local NODE_VER NODE_MAJOR
        NODE_VER=$(node -v | sed 's/^v//')
        NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
        if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
            print_success "Node.js v$NODE_VER (meets 18+ requirement)"
            if [ "$NODE_MAJOR" -lt 20 ]; then
                print_warning "Node $NODE_MAJOR is past end-of-life. Consider upgrading to Node 22 LTS."
            fi
        else
            print_error "Node.js 18+ required. You have v$NODE_VER."
            echo "  Install: visit https://nodejs.org and install 22 LTS,"
            echo "  or if you have Homebrew: brew install node"
            PREFLIGHT_OK=false
        fi
    else
        print_error "Node.js not installed."
        echo "  Install: visit https://nodejs.org and install 22 LTS,"
        echo "  or if you have Homebrew: brew install node"
        PREFLIGHT_OK=false
    fi

    # Homebrew (macOS only)
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if command -v brew &>/dev/null; then
            print_success "Homebrew installed ($(brew --version 2>/dev/null | head -1 | awk '{print $2}'))"
        else
            print_error "Homebrew not installed (required on macOS)."
            echo "  Install: visit https://brew.sh and follow the one-line install command there."
            PREFLIGHT_OK=false
        fi
    fi

    # Claude Code CLI
    if command -v claude &>/dev/null; then
        print_success "Claude Code CLI installed ($(claude --version 2>/dev/null | head -1))"
    else
        print_error "Claude Code CLI not installed."
        echo "  Install: npm install -g @anthropic-ai/claude-code"
        echo "  Docs:    https://code.claude.com/docs/en/quickstart"
        PREFLIGHT_OK=false
    fi

    # Git
    if command -v git &>/dev/null; then
        print_success "Git installed ($(git --version 2>/dev/null | awk '{print $3}'))"
    else
        print_error "Git not installed."
        echo "  macOS: run 'xcode-select --install' or install via Homebrew."
        PREFLIGHT_OK=false
    fi

    # Note: we intentionally do NOT check GitHub repo access here. If the
    # user got this far, 'git clone' already proved access. A separate
    # 'git ls-remote' from inside this script runs without a TTY; for private
    # repos the askpass helper hangs until timeout kills it, producing a
    # false-negative warning even when access is fine.

    echo ""
    if [ "$PREFLIGHT_OK" != true ]; then
        echo -e "${RED}Pre-flight check failed.${NC} Install the missing requirements above, then re-run:"
        echo -e "  ${CYAN}./setup.sh${NC}"
        exit 1
    fi

    # Account prereqs the wizard can't auto-verify
    echo -e "${BOLD}Account prerequisites — please confirm:${NC}"
    echo ""
    echo "  [ ] Claude Max subscription (5x or 20x)"
    echo "      Not Pro, not Free, not Team Standard."
    echo "      Plans: https://claude.com/pricing"
    echo ""
    echo "  [ ] Your own Discord server (or admin rights on one)"
    echo ""
    echo "  [ ] Your Discord User ID ready to paste"
    echo "      How: Discord Settings → Advanced → Developer Mode ON,"
    echo "           then right-click your name → Copy User ID"
    echo ""
    read -p "Confirm you have all 3? (y/n): " ACCOUNT_CONFIRM
    if [[ "$ACCOUNT_CONFIRM" != "y" && "$ACCOUNT_CONFIRM" != "Y" ]]; then
        echo ""
        echo "No problem. Come back when you've got these."
        echo "Run ./setup.sh again to restart."
        exit 0
    fi
    echo ""
}

# Helper: ensure a command is in PATH, fix if needed
ensure_npm_global_path() {
    if command -v "$1" &>/dev/null; then
        return 0
    fi

    # Command not found — try to fix PATH
    local npm_prefix
    npm_prefix=$(npm config get prefix 2>/dev/null)
    if [ -n "$npm_prefix" ] && [ -d "$npm_prefix/bin" ]; then
        export PATH="$npm_prefix/bin:$PATH"
        if command -v "$1" &>/dev/null; then
            # Persist the fix
            local shell_rc="$HOME/.zshrc"
            [[ "$SHELL" == *bash* ]] && shell_rc="$HOME/.bashrc"
            if ! grep -qF "$npm_prefix/bin" "$shell_rc" 2>/dev/null; then
                echo "export PATH=\"$npm_prefix/bin:\$PATH\"" >> "$shell_rc"
                print_warning "Added $npm_prefix/bin to PATH in $(basename "$shell_rc")"
            fi
            return 0
        fi
    fi

    return 1
}

# Helper: npm install -g with eager PATH export so the binary is
# immediately available in subsequent commands within the same wizard run.
npm_install_global() {
    npm install -g "$@"
    local prefix
    prefix=$(npm config get prefix 2>/dev/null)
    if [ -n "$prefix" ] && [ -d "$prefix/bin" ]; then
        export PATH="$prefix/bin:$PATH"
    fi
}

# ============================================================
# Checkpoint / Resume
# ============================================================
#
# Setup progress is tracked in ./.setup-state so a failed or abandoned
# wizard can be resumed without re-running completed steps.
#
# File format (simple key=value, no jq dep):
#   version=1.1.6
#   last_step=3
#   completed=1,2,3
#   timestamp=2026-04-22T14:30:00Z

STATE_FILE="./.setup-state"
WIZARD_VERSION="1.1.13"
COMPLETED_STEPS=""

format_step_progress() {
    local step="$1"
    case "$step" in
        9a|9b)
            echo "${step}/10"
            ;;
        "")
            echo "0/10"
            ;;
        *)
            echo "${step}/10"
            ;;
    esac
}

next_step_label() {
    local step="$1"
    case "$step" in
        9a)
            echo "9b"
            ;;
        9b)
            echo "10"
            ;;
        ""|0)
            echo "1"
            ;;
        *)
            echo "$((step + 1))"
            ;;
    esac
}

state_load() {
    if [ ! -f "$STATE_FILE" ]; then
        return 1
    fi
    COMPLETED_STEPS=$(grep '^completed=' "$STATE_FILE" 2>/dev/null | cut -d= -f2)
    local saved_version
    saved_version=$(grep '^version=' "$STATE_FILE" 2>/dev/null | cut -d= -f2)
    if [ "$saved_version" != "$WIZARD_VERSION" ]; then
        print_warning "Setup state is from wizard version $saved_version; current is $WIZARD_VERSION."
        print_warning "Wizard updated since your last run; re-running steps to pick up new logic. Your existing config is preserved."
        rm -f "$STATE_FILE"
        COMPLETED_STEPS=""
        return 1
    fi
    return 0
}

state_save() {
    local step="$1"
    if ! step_done "$step"; then
        if [ -n "$COMPLETED_STEPS" ]; then
            COMPLETED_STEPS="$COMPLETED_STEPS,$step"
        else
            COMPLETED_STEPS="$step"
        fi
    fi
    cat > "$STATE_FILE" <<EOF
version=$WIZARD_VERSION
last_step=$step
completed=$COMPLETED_STEPS
timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
}

state_clear() {
    rm -f "$STATE_FILE"
    rm -f /tmp/.hive-setup-step9-ok
    rm -f /tmp/.hive-setup-step9a-ok
    rm -f /tmp/.hive-setup-codex-installed
    COMPLETED_STEPS=""
}

step_done() {
    local step="$1"
    [[ ",$COMPLETED_STEPS," == *",$step,"* ]]
}

migrate_legacy_step9a_state() {
    if [ -f /tmp/.hive-setup-step9a-ok ] && step_done 8 && ! step_done 9a && ! step_done 9b; then
        print_warning "Found legacy Step 9a marker; migrating it into setup state."
        state_save 9a
        rm -f /tmp/.hive-setup-step9a-ok
    fi
}

# Called if wizard is interrupted (Ctrl-C, error with set -e)
on_interrupt() {
    local exit_code=$?
    echo ""
    echo ""
    if [ -n "$COMPLETED_STEPS" ]; then
        print_warning "Setup interrupted at step $CURRENT_STEP. Progress saved."
        echo ""
        echo "To resume where you left off:"
        echo -e "  ${CYAN}./setup.sh --resume${NC}"
        echo ""
        echo "To diagnose and fix what broke:"
        echo -e "  ${CYAN}hive doctor --fix-setup${NC}"
        echo ""
        echo "To delete progress and start over from Step 1:"
        echo -e "  ${CYAN}./setup.sh --fresh${NC}"
    else
        print_error "Setup failed before any step completed."
        echo "See error above, then re-run: ./setup.sh"
    fi
    exit "$exit_code"
}

# Parse args
FORCE_FRESH=false
AUTO_RESUME=false
AUTO_YES=false
IS_POST_INSTALL=false
FORCE_BUILD=false
for arg in "$@"; do
    case "$arg" in
        --fresh|--restart)
            FORCE_FRESH=true
            ;;
        --resume)
            AUTO_RESUME=true
            ;;
        --yes|-y)
            AUTO_YES=true
            ;;
        --post-install)
            IS_POST_INSTALL=true
            ;;
        --force-build)
            FORCE_BUILD=true
            ;;
        --help|-h)
            echo "Usage: ./setup.sh [--fresh|--resume|--yes|--post-install|--force-build|--help]"
            echo ""
            echo "  --fresh         Force a fresh start; discard saved state."
            echo "  --resume        Resume from saved state."
            echo "  --yes, -y       Auto-confirm where safe."
            echo "  --post-install  Run as a post-install handoff from install.sh."
            echo "  --force-build   Rebuild even if dist/ is already fresh."
            echo "  --help, -h      Show this help."
            exit 0
            ;;
    esac
done

CURRENT_STEP=0
trap on_interrupt INT TERM ERR

# ============================================================
# Pre-flight
# ============================================================

print_header

# Track whether this run is starting fresh vs resuming. Pre-flight +
# opening screen only show on fresh — resumers already saw them.
IS_FRESH_START=true

# F.3 — auto-detect post-install state if --post-install not explicitly passed
if [ "${IS_POST_INSTALL}" = "false" ]; then
    POST_INSTALL_STATE="$(detect_post_install_state)"
    if [ "${POST_INSTALL_STATE}" = "post_fresh_install" ]; then
        IS_POST_INSTALL=true
    fi
else
    POST_INSTALL_STATE="post_fresh_install"
fi
export POST_INSTALL_STATE

# --- Resume logic ---
if [ "$FORCE_FRESH" = true ]; then
    # If there's existing state, confirm before nuking it (unless --yes).
    # Protects against typos like `--fresh` when the user meant `--resume`.
    if [ -f "$STATE_FILE" ] && [ "$AUTO_YES" != true ]; then
        EXISTING_STEP=$(grep '^last_step=' "$STATE_FILE" 2>/dev/null | cut -d= -f2)
        echo -e "${YELLOW}--fresh will delete existing progress (currently at step $EXISTING_STEP/10).${NC}"
        echo ""
        read -p "Delete state and restart from Step 1? (y/N): " CONFIRM
        if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
            echo "Aborted. No changes made."
            echo "To resume instead, run: ./setup.sh --resume"
            exit 0
        fi
    fi
    state_clear
    echo "Starting fresh setup (--fresh flag)."
    echo ""
elif state_load; then
    LAST_STEP=$(grep '^last_step=' "$STATE_FILE" 2>/dev/null | cut -d= -f2)
    TS=$(grep '^timestamp=' "$STATE_FILE" 2>/dev/null | cut -d= -f2)
    migrate_legacy_step9a_state
    LAST_STEP=$(grep '^last_step=' "$STATE_FILE" 2>/dev/null | cut -d= -f2)
    echo -e "${YELLOW}Found previous setup progress.${NC}"
    echo "  Last completed step: $(format_step_progress "$LAST_STEP")"
    echo "  Saved: $TS"
    echo ""
    if [ "$AUTO_RESUME" = true ]; then
        REPLY="R"
    else
        echo "Options:"
        echo "  [R] Resume from step $(next_step_label "$LAST_STEP")"
        echo "  [S] Delete state and restart from Step 1"
        echo "  [Q] Quit"
        echo ""
        read -p "Choice [R/s/q]: " REPLY
        REPLY="${REPLY:-R}"
    fi
    case "$REPLY" in
        [Ss]*)
            state_clear
            echo "Starting fresh."
            echo ""
            ;;
        [Qq]*)
            echo "Quitting. Run ./setup.sh again to resume."
            exit 0
            ;;
        *)
            echo "Resuming from step $(next_step_label "$LAST_STEP")."
            echo ""
            IS_FRESH_START=false
            ;;
    esac
fi

# Pre-flight + opening screen only on fresh starts. Resumers already
# passed these; re-running would be noise.
if [ "$IS_FRESH_START" = true ]; then
    run_preflight
    print_opening
fi

# Warn if $HOME contains spaces — some npm packages mishandle spaced paths.
if [[ "$HOME" == *" "* ]]; then
    print_warning "Your home directory contains spaces ($HOME)."
    echo "Hive should still work, but some npm packages mishandle spaces in paths."
    echo "If you hit weird errors, consider creating a symlink at /opt/$USER → $HOME."
    echo ""
    read -p "Continue anyway? (y/N): " CONTINUE_SPACED
    if [[ "$CONTINUE_SPACED" != "y" && "$CONTINUE_SPACED" != "Y" ]]; then
        exit 0
    fi
fi

# Detect OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
    echo "Detected: macOS"
elif [[ "$OSTYPE" == "linux"* ]]; then
    OS="linux"
    echo "Detected: Linux"
else
    print_error "Unsupported OS: $OSTYPE"
    echo "Hive supports macOS and Linux."
    exit 1
fi

# ============================================================
# Step 1: Node.js
# ============================================================

if ! step_done 1; then
    CURRENT_STEP=1
    print_step "1/10" "Checking Node.js"

    if command -v node &> /dev/null; then
        NODE_VERSION=$(node --version)
        NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
        if [ "$NODE_MAJOR" -ge 18 ]; then
            print_success "Node.js $NODE_VERSION installed"
        else
            print_error "Node.js $NODE_VERSION is too old (need 18+)"
            echo "Install the latest version from https://nodejs.org"
            exit 1
        fi
    else
        print_error "Node.js is not installed"
        echo ""
        if [[ "$OS" == "macos" ]]; then
            echo "Install with Homebrew:"
            echo "  brew install node"
            echo ""
            echo "Or download from https://nodejs.org"
        else
            echo "Install with your package manager:"
            echo "  sudo apt install nodejs npm    # Ubuntu/Debian"
            echo "  sudo dnf install nodejs npm    # Fedora"
            echo ""
            echo "Or download from https://nodejs.org"
        fi
        exit 1
    fi

    state_save 1
else
    print_success "Step 1/10: Node.js (already complete, skipping)"
fi

# ============================================================
# Step 2: PM2
# ============================================================

if ! step_done 2; then
    CURRENT_STEP=2
    print_step "2/10" "Installing Tools"

# --- pnpm via Corepack (v1.5.4) ---
# Corepack ships with Node ≥16 and auto-respects package.json's
# packageManager field. Step 9 uses pnpm; this guarantees it's available
# BEFORE step 9 runs, regardless of whether install.sh succeeded at the
# 'npm install -g pnpm' substep or whether the user bypassed install.sh.
if command -v corepack &>/dev/null; then
    corepack enable 2>/dev/null || true
    if command -v pnpm &>/dev/null; then
        print_success "pnpm available ($(pnpm --version 2>/dev/null || echo 'via corepack'))"
    else
        # Corepack enabled but pnpm shim not yet active — try preparing it.
        corepack prepare pnpm@10.30.3 --activate 2>/dev/null || true
        if command -v pnpm &>/dev/null; then
            print_success "pnpm activated via corepack"
        else
            print_warning "pnpm not on PATH after corepack — falling back to npm install -g pnpm"
            npm_install_global pnpm
        fi
    fi
else
    # Corepack missing (Node <16 or detached install). Use npm install -g.
    if command -v pnpm &>/dev/null; then
        print_success "pnpm installed"
    else
        echo "Installing pnpm (corepack not available)..."
        npm_install_global pnpm
        print_success "pnpm installed"
    fi
fi

# --- Homebrew (required on macOS) ---
if [[ "$OS" == "macos" ]]; then
    if ! command -v brew &>/dev/null; then
        print_error "Homebrew is not installed. Install it first:"
        echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
        exit 1
    fi
    print_success "Homebrew installed"
fi

# --- PM2 ---
if command -v pm2 &> /dev/null; then
    print_success "PM2 installed"
else
    echo "Installing PM2 (process manager for your agents)..."
    npm_install_global pm2

    # Verify it's accessible
    if ! ensure_npm_global_path pm2; then
        print_error "PM2 installed but not found in PATH."
        echo "Try opening a new terminal and running setup.sh again."
        exit 1
    fi
    print_success "PM2 installed"
fi

# --- Vercel CLI ---
if command -v vercel &>/dev/null; then
    print_success "Vercel CLI installed"
else
    echo "Installing Vercel CLI..."
    npm_install_global vercel
    print_success "Vercel CLI installed"
fi

# --- Brew packages (macOS) / apt packages (Linux) ---
if [[ "$OS" == "macos" ]]; then
    BREW_TOOLS=(
        "flock:flock"
        "gh:gh"
        "jq:jq"
        "tmux:tmux"
        "ffmpeg:ffmpeg"
        "pandoc:pandoc"
        "sqlite3:sqlite3"
    )
    BREW_CASKS=(
        "bq:google-cloud-sdk"
    )
    # gws (Google Workspace CLI) — separate because the command and formula differ
    if command -v gws &>/dev/null; then
        print_success "gws (Google Workspace CLI) already installed"
    else
        echo "Installing Google Workspace CLI..."
        brew install googleworkspace-cli
        print_success "gws (Google Workspace CLI) installed"
    fi

    for entry in "${BREW_TOOLS[@]}"; do
        cmd="${entry%%:*}"
        pkg="${entry##*:}"
        if command -v "$cmd" &>/dev/null; then
            print_success "$cmd already installed"
        else
            echo "Installing $pkg..."
            brew install "$pkg"
            print_success "$cmd installed"
        fi
    done

    for entry in "${BREW_CASKS[@]}"; do
        cmd="${entry%%:*}"
        pkg="${entry##*:}"
        if command -v "$cmd" &>/dev/null; then
            print_success "$cmd already installed"
        else
            echo "Installing $pkg..."
            # Tolerate cask install failures (e.g. google-cloud-sdk's
            # post-install hook needs `virtualenv` and dies on systems where
            # it isn't installed). The wizard should keep going — users
            # without BigQuery don't need gcloud, and users who do can
            # install it later via `brew install --cask google-cloud-sdk`
            # after running `pip3 install virtualenv`.
            if ! brew install --cask "$pkg" 2>&1; then
                print_warning "$pkg failed to install — skipping. You can install it manually later if you need it."
                if [[ "$pkg" == "google-cloud-sdk" ]]; then
                    echo "  (gcloud is only needed for BigQuery. To retry: pip3 install virtualenv && brew install --cask google-cloud-sdk)"
                fi
                continue
            fi
            print_success "$cmd installed"
        fi
    done
else
    # Linux — apt-based
    APT_TOOLS=(
        "flock:util-linux"
        "gh:gh"
        "jq:jq"
        "tmux:tmux"
        "ffmpeg:ffmpeg"
        "pandoc:pandoc"
        "sqlite3:sqlite3"
    )
    MISSING_APT=()
    MISSING_APT_PACKAGES=()
    for entry in "${APT_TOOLS[@]}"; do
        cmd="${entry%%:*}"
        pkg="${entry##*:}"
        if command -v "$cmd" &>/dev/null; then
            print_success "$cmd already installed"
        else
            MISSING_APT+=("$entry")
            MISSING_APT_PACKAGES+=("$pkg")
        fi
    done
    if [ ${#MISSING_APT[@]} -gt 0 ]; then
        echo "Installing: ${MISSING_APT_PACKAGES[*]}..."
        sudo apt-get update -qq
        for entry in "${MISSING_APT[@]}"; do
            cmd="${entry%%:*}"
            pkg="${entry##*:}"
            sudo apt-get install -y -qq "$pkg"
            print_success "$cmd installed"
        done
    fi

    # Google Cloud SDK (Linux)
    if command -v bq &>/dev/null; then
        print_success "bq (BigQuery CLI) already installed"
    else
        echo "Installing Google Cloud SDK..."
        echo "See: https://cloud.google.com/sdk/docs/install"
        print_warning "Google Cloud SDK — install manually from the link above"
    fi

    # Google Workspace CLI (Linux)
    if command -v gws &>/dev/null; then
        print_success "gws (Google Workspace CLI) already installed"
    else
        echo "See: https://github.com/googleworkspaceplatform/google-workspace-cli/releases"
        print_warning "Google Workspace CLI — install the Go binary from the link above"
    fi
fi

    state_save 2
else
    print_success "Step 2/10: Tools (already complete, skipping)"
fi

# ============================================================
# Step 3: Claude Code CLI
# ============================================================

if ! step_done 3; then
    CURRENT_STEP=3
    print_step "3/10" "Checking Claude Code CLI"

    if command -v claude &> /dev/null; then
        CLAUDE_VERSION=$(claude --version 2>/dev/null || echo "unknown")
        print_success "Claude Code CLI installed ($CLAUDE_VERSION)"
    else
        echo "Installing Claude Code CLI..."
        npm_install_global @anthropic-ai/claude-code
        # Source shell profile to pick up new PATH
        [ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null || true
        [ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null || true
        if ! command -v claude &>/dev/null; then
            print_warning "Claude CLI installed but not in PATH yet."
            echo "You may need to open a new terminal after setup."
        else
            print_success "Claude Code CLI installed"
        fi
    fi

    state_save 3
else
    print_success "Step 3/10: Claude CLI (already complete, skipping)"
fi

# ============================================================
# Step 4: Claude Authentication
# ============================================================

if ! step_done 4; then
    CURRENT_STEP=4
    print_step "4/10" "Claude Authentication"

# --- Check for ANTHROPIC_API_KEY conflicts ---
API_KEY_CONFLICT=false
API_KEY_FILES=()

# Check environment
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    API_KEY_CONFLICT=true
fi

# Check shell profiles
for rc_file in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.zprofile" "$HOME/.bash_profile"; do
    if [ -f "$rc_file" ] && grep -q "ANTHROPIC_API_KEY" "$rc_file" 2>/dev/null; then
        API_KEY_CONFLICT=true
        API_KEY_FILES+=("$rc_file")
    fi
done

if [ "$API_KEY_CONFLICT" = true ]; then
    echo -e "${YELLOW}⚠  Found ANTHROPIC_API_KEY in your environment.${NC}"
    echo ""
    echo "Hive uses your Claude Max subscription (via 'claude setup-token'),"
    echo "NOT an API key. Having an API key set will override your subscription"
    echo "and cause 'credit balance too low' errors."
    echo ""

    if [ ${#API_KEY_FILES[@]} -gt 0 ]; then
        echo "Found in:"
        for f in "${API_KEY_FILES[@]}"; do
            echo "  $f"
        done
        echo ""
    fi

    read -p "Remove ANTHROPIC_API_KEY from your environment? (Y/n): " REMOVE_KEY
    if [[ "$REMOVE_KEY" != "n" && "$REMOVE_KEY" != "N" ]]; then
        # Remove from shell profiles
        for rc_file in "${API_KEY_FILES[@]}"; do
            if [ -f "$rc_file" ]; then
                # Create backup
                cp "$rc_file" "${rc_file}.bak"
                # Remove the line(s) containing ANTHROPIC_API_KEY
                grep -v "ANTHROPIC_API_KEY" "$rc_file" > "${rc_file}.tmp" && mv "${rc_file}.tmp" "$rc_file"
                print_success "Removed from $rc_file (backup: ${rc_file}.bak)"
            fi
        done
        # Unset from current session
        unset ANTHROPIC_API_KEY
        print_success "ANTHROPIC_API_KEY cleared"
    else
        print_warning "Leaving ANTHROPIC_API_KEY in place. You may hit billing errors."
    fi
    echo ""
fi

# --- Authenticate ---
# Probe for existing auth before prompting the user to run setup-token.
PROBE_AUTH_OK=false
AUTH_PROBE=$(claude auth status 2>&1 || true)
if echo "$AUTH_PROBE" | grep -q '"loggedIn": true'; then
    print_success "Claude already authenticated"
    PROBE_AUTH_OK=true
fi

if [ "$PROBE_AUTH_OK" != true ]; then
    echo "You need a Claude Max subscription (5x or 20x)."
    echo -e "${BOLD}Important:${NC} Do NOT use an API key. Use your subscription login."
    echo ""
    print_escape_footer
    read -p "Have you already run 'claude setup-token'? (y/n): " CLAUDE_AUTH

    if [[ "$CLAUDE_AUTH" != "y" && "$CLAUDE_AUTH" != "Y" ]]; then
        echo ""
        echo "Running claude setup-token..."
        echo "A browser window will open. Sign in with your Claude account."
        echo ""
        claude setup-token
    fi
fi

# --- Verify auth type ---
echo ""
echo "Verifying authentication..."
AUTH_OUTPUT=$(claude auth status 2>&1 || true)

if echo "$AUTH_OUTPUT" | grep -qi "api.key\|api_key\|apikey"; then
    echo ""
    print_error "Claude is authenticated with an API key, not a subscription."
    echo ""
    echo "Hive requires a Claude Max subscription (5x or 20x)."
    echo "Run 'claude setup-token' to authenticate with your subscription."
    echo ""
    echo "If you previously set an ANTHROPIC_API_KEY, make sure it's been"
    echo "removed from your shell profile (~/.zshrc, ~/.bashrc, etc.)"
    echo "and open a new terminal before trying again."
    exit 1
fi

print_success "Claude authenticated"

    state_save 4
else
    print_success "Step 4/10: Claude auth (already complete, skipping)"
fi

# ============================================================
# Step 5: Codex CLI (Optional)
# ============================================================

if ! step_done 5; then
    CURRENT_STEP=5
    print_step "5/10" "Codex CLI (Optional)"

echo "Codex is OpenAI's coding CLI. It's optional — your agents can"
echo "use Claude Code CLI instead. But if you have an OpenAI Pro"
echo "subscription, Codex gives you unlimited coding with no extra cost."
echo ""
read -p "Install Codex CLI? (y/N): " INSTALL_CODEX

if [[ "$INSTALL_CODEX" == "y" || "$INSTALL_CODEX" == "Y" ]]; then
    if command -v codex &> /dev/null; then
        print_success "Codex CLI already installed"
    else
        echo "Installing Codex CLI..."
        npm_install_global @openai/codex
        print_success "Codex CLI installed"
        echo ""
        echo "You'll need to authenticate Codex separately."
        echo "Run 'codex' in your terminal after setup to log in."
    fi
    touch /tmp/.hive-setup-codex-installed
else
    print_success "Skipping Codex (agents will use Claude Code CLI)"
fi

    state_save 5
else
    print_success "Step 5/10: Codex (already complete, skipping)"
fi

# ============================================================
# Step 6: Discord Setup
# ============================================================

if ! step_done 6; then
    CURRENT_STEP=6
    print_step "6/10" "Discord Setup"

echo "Each agent needs a Discord bot. Let's create one for House MD,"
echo "your first agent. House builds and maintains all your other agents."
echo ""
echo -e "${BOLD}Do this now:${NC}"
echo ""
echo "  1. Go to https://discord.com/developers/applications"
echo "  2. Click 'New Application'"
echo "  3. Name it: House MD"
echo "  4. Click 'Create'"
echo "  5. Click 'Bot' in the left sidebar"
echo "  6. Turn on ALL THREE toggles under 'Privileged Gateway Intents':"
echo "     - Presence Intent → ON"
echo "     - Server Members Intent → ON"
echo "     - Message Content Intent → ON"
echo "  7. Click 'Save Changes'"
echo "  8. Click 'Reset Token' → copy the token"
echo "  9. Click 'OAuth2' → 'URL Generator'"
echo "  10. Check 'bot' under Scopes"
echo "  11. Check 'Administrator' under Bot Permissions"
echo "  12. Copy the URL at the bottom, open it in your browser"
echo "  13. Select your Discord server → Authorize"
echo "  14. Create a channel called #house-md in your server"
echo ""

prompt_continue

# --- Bot token with validation ---
echo ""
print_escape_footer
read -p "Paste your House MD bot token here: " BOT_TOKEN

while true; do
    if [ -z "$BOT_TOKEN" ]; then
        print_error "Bot token can't be empty"
        read -p "Paste your House MD bot token here: " BOT_TOKEN
        continue
    fi

    # Discord bot tokens are base64-encoded and typically 59-76 chars with dots
    if [[ ! "$BOT_TOKEN" =~ ^[A-Za-z0-9._-]{50,}$ ]]; then
        print_warning "That doesn't look like a valid Discord bot token."
        echo "Discord bot tokens are long strings with dots (e.g., MTQ5...abc.G1v...xyz)"
        read -p "Paste a valid token: " BOT_TOKEN
        continue
    fi

    # API ping — verify the token is actually accepted by Discord
    API_RESPONSE=$(curl -s -w "\n%{http_code}" -H "Authorization: Bot $BOT_TOKEN" https://discord.com/api/v10/users/@me 2>/dev/null || echo $'\n000')
    API_CODE=$(echo "$API_RESPONSE" | tail -n1)

    if [ "$API_CODE" = "200" ]; then
        break
    elif [ "$API_CODE" = "401" ]; then
        print_error "Discord rejected that token (401). Reset it at https://discord.com/developers/applications and paste the new one."
        read -p "Paste your House MD bot token here: " BOT_TOKEN
        continue
    elif [ "$API_CODE" = "000" ]; then
        print_warning "Couldn't reach Discord — your token format looks valid; we'll catch any issue on first connect."
        break
    else
        API_BODY=$(echo "$API_RESPONSE" | sed '$d')
        print_error "Discord API returned $API_CODE: ${API_BODY:0:200}"
        read -p "Paste your House MD bot token here: " BOT_TOKEN
        continue
    fi
done

# --- Owner ID with validation ---
echo ""
echo "Now I need your Discord user ID."
echo ""
echo "  1. Open Discord"
echo "  2. Go to Settings → Advanced → Developer Mode → ON"
echo "  3. Right-click your own name in any chat"
echo "  4. Click 'Copy User ID'"
echo ""
print_escape_footer
read -p "Paste your Discord user ID here: " OWNER_ID

while true; do
    if [ -z "$OWNER_ID" ]; then
        print_error "Owner ID can't be empty"
        read -p "Paste your Discord user ID here: " OWNER_ID
        continue
    fi

    # Discord user IDs are 17-20 digit numbers
    if [[ ! "$OWNER_ID" =~ ^[0-9]{17,20}$ ]]; then
        print_warning "That doesn't look like a Discord user ID."
        echo "Discord user IDs are 17-20 digit numbers (e.g., 123456789012345678)"
        read -p "Try again: " OWNER_ID
        continue
    fi
    break
done

print_success "Discord configured"

# Persist Discord credentials to .env immediately so resume works across steps.
# Use env_upsert to preserve any existing keys (ANTHROPIC_API_KEY, etc.) on re-runs.
ENV_EXISTED=false
[ -f .env ] && ENV_EXISTED=true
env_upsert "DISCORD_BOT_TOKEN_HOUSE_MD" "$BOT_TOKEN"
env_upsert "DISCORD_OWNER_ID" "$OWNER_ID"
if [ "$ENV_EXISTED" = true ]; then
    print_success "Updated .env with Discord credentials (existing keys preserved)"
else
    print_success "Created .env with Discord credentials"
fi

    state_save 6
else
    print_success "Step 6/10: Discord (already complete, skipping)"
fi

# ============================================================
# Step 7: Google Workspace Auth (Optional)
# ============================================================

if ! step_done 7; then
    CURRENT_STEP=7
    print_step "7/10" "Google Workspace Auth (Optional)"

    echo "The gws CLI is installed but needs OAuth consent before agents can use it."
    echo "This lets agents read/write Drive, Sheets, Docs, Gmail, Calendar as you."
    echo ""
    echo "You'll need your own Google OAuth Desktop client (client_secret.json)."
    echo "Create one at: https://console.cloud.google.com/apis/credentials"
    echo "  → Create Credentials → OAuth client ID → Application type: Desktop app"
    echo "  → Download the JSON and save to: ~/.config/gws/client_secret.json"
    echo ""
    echo "Skip if your agents don't need Google Workspace access."
    echo ""
    print_escape_footer
    read -p "Set up Google Workspace auth now? (y/N): " SETUP_GWS

    if [[ "$SETUP_GWS" == "y" || "$SETUP_GWS" == "Y" ]]; then
        # Already authed? Match both "oauth" and "oauth2" — real output is "oauth2".
        if gws auth status 2>/dev/null | grep -qE '"auth_method":\s*"oauth2?"'; then
            print_success "gws already authenticated — skipping"
        else
            GWS_CONFIG_DIR="$HOME/.config/gws"
            GWS_CLIENT_SECRET="$GWS_CONFIG_DIR/client_secret.json"

            mkdir -p "$GWS_CONFIG_DIR"

            if [ ! -f "$GWS_CLIENT_SECRET" ]; then
                print_warning "No client_secret.json found at $GWS_CLIENT_SECRET"
                echo ""
                echo "Provide your own Google OAuth Desktop client:"
                echo "  1. Go to https://console.cloud.google.com/apis/credentials"
                echo "  2. Create Credentials → OAuth client ID → Desktop app"
                echo "  3. Enable APIs: Drive, Sheets, Gmail, Calendar, Docs"
                echo "  4. Download the JSON and save it as:"
                echo "       $GWS_CLIENT_SECRET"
                echo ""
                read -p "Press ENTER once the file is in place (or Ctrl-C to skip): " _
            fi

            if [ ! -f "$GWS_CLIENT_SECRET" ]; then
                print_warning "Still no client_secret.json — skipping gws auth. Run setup.sh again when ready."
                state_save 7
                return 0 2>/dev/null || true
            fi

            chmod 600 "$GWS_CLIENT_SECRET"
            print_success "OAuth client detected → $GWS_CLIENT_SECRET"

            echo ""
            echo "Opening browser for OAuth consent..."
            echo "Sign in with your Google account and grant the requested scopes."
            echo "Scopes requested: Drive, Sheets, Gmail, Calendar, Docs"
            echo ""
            prompt_continue

            # -s limits the consent screen to just these services. Your OAuth
            # client must have these APIs enabled in its GCP project.
            gws auth login -s drive,sheets,gmail,calendar,docs \
                || print_warning "gws auth login did not complete — run it again manually later"

            if gws auth status 2>/dev/null | grep -qE '"auth_method":\s*"oauth2?"'; then
                print_success "gws authenticated"
            else
                print_warning "gws auth incomplete — run 'gws auth login -s drive,sheets,gmail,calendar,docs' manually"
            fi
        fi
    else
        echo "Skipping gws auth. Run setup.sh again later or consult the docs."
    fi

    state_save 7
else
    print_success "Step 7/10: Google Workspace auth (already complete, skipping)"
fi

# ============================================================
# Step 8: Create Working Directory
# ============================================================

if ! step_done 8; then
    CURRENT_STEP=8
    print_step "8/10" "Setting Up Directories"

    WORKING_DIR="$HOME/projects"
    mkdir -p "$WORKING_DIR"
    print_success "Working directory: $WORKING_DIR"

    # Append WORKING_DIR to .env so later steps and future runs have it.
    if [ -f .env ] && ! grep -q '^WORKING_DIR=' .env; then
        echo "WORKING_DIR=$WORKING_DIR" >> .env
    fi

    # Patch config.yaml so safety hooks allow writes to this install directory.
    # Users may clone to ~/neato-hive, ~/hive, or anywhere else — detect actual path.
    INSTALL_DIR="$(pwd)"
    INSTALL_DIR_TILDE="${INSTALL_DIR/#$HOME/~}"
    if [ -f config/config.yaml ]; then
        # Replace the install-path entry in allowed_paths with the actual location.
        # Works whether default config says ~/neato-hive or ~/hive.
        sed -i.bak -E "s#^(    - )(~/neato-hive|~/hive)\$#\1${INSTALL_DIR_TILDE}#" config/config.yaml
        rm -f config/config.yaml.bak
        print_success "Patched config.yaml allowed_paths → $INSTALL_DIR_TILDE"
    fi

    # J.1.0.6 — materialize House MD from templates on fresh install
    if ! materialize_house_md; then
        print_error "House MD materialization failed — cannot continue setup."
        trap - INT TERM ERR
        exit 1
    fi

    state_save 8
else
    print_success "Step 8/10: Directories (already complete, skipping)"
fi

# ============================================================
# Step 9a: Install & Build & Link
# ============================================================

if ! step_done 9a; then
    CURRENT_STEP="9a"
    print_step "9a/10" "Installing, Building & Linking"

    # .env was written in Steps 6 and 7. Verify it exists before continuing.
    if [ ! -f .env ]; then
        print_error ".env file is missing. Run './setup.sh --fresh' to restart cleanly."
        exit 1
    fi
    print_success ".env present"

# v1.5.4 — use pnpm, NOT npm. Root cause of v1.5.1/2/3 step 9 failures:
# the repo declares "packageManager": "pnpm@10.30.3" and ships pnpm-lock.yaml
# (no package-lock.json). install.sh runs pnpm install, producing a
# pnpm-shaped node_modules with the .pnpm/ symlink store. The previous
# setup.sh step 9 then ran `npm install` on top of that tree, which
# crashed inside @npmcli/arborist with TypeError trying to reconcile
# pnpm's symlink layout. v1.5.3 made the crash visible by removing
# --silent; v1.5.4 fixes the actual mismatch by using pnpm throughout.
# bin/hive is a standalone bash script — `npm link` for the CLI install
# is kept because ensure_npm_global_path checks `npm config get prefix`.

# Install dependencies (pnpm — matches packageManager field + lockfile)
echo "Installing dependencies..."
if ! pnpm install --frozen-lockfile; then
    print_error "pnpm install failed."
    echo ""
    echo "Recovery (most common causes):"
    echo "  - pnpm not available → 'corepack enable' (Node ≥16 ships with corepack)"
    echo "                       OR 'npm install -g pnpm'"
    echo "  - Network unreachable → check 'curl -sI https://registry.npmjs.org'"
    echo "  - Lockfile drift → 'pnpm install' (without --frozen-lockfile) to regenerate"
    echo "  - Mixed npm/pnpm state → 'rm -rf node_modules && pnpm install --frozen-lockfile'"
    echo ""
    echo "Then re-run: ./setup.sh --resume"
    trap - INT TERM ERR
    exit 1
fi
print_success "Dependencies installed"

# Build (pnpm run build) unless tarball-shipped dist/ is already fresh.
SHOULD_BUILD=true
if [ "$FORCE_BUILD" = true ]; then
    echo "Building (--force-build)..."
elif [ -f dist/index.js ] && [ -f pnpm-lock.yaml ] && [ dist/index.js -nt pnpm-lock.yaml ]; then
    SHOULD_BUILD=false
    print_success "build cache fresh — skipping"
else
    echo "Building..."
fi

if [ "$SHOULD_BUILD" = true ]; then
    if ! pnpm run build; then
        print_error "pnpm run build failed."
        echo ""
        echo "TypeScript compilation errors are shown above. Fix the build,"
        echo "then re-run: ./setup.sh --resume"
        trap - INT TERM ERR
        exit 1
    fi
    print_success "Build complete"
fi

# Install hive CLI globally
echo "Installing hive CLI..."
if ! npm link; then
    print_error "npm link failed."
    echo ""
    echo "Recovery (most common cause: permissions on npm global dir):"
    echo "  sudo chown -R \$(whoami) \$(npm config get prefix)/{lib/node_modules,bin}"
    echo ""
    echo "Then re-run: ./setup.sh --resume"
    trap - INT TERM ERR
    exit 1
fi

# v1.5.3 — hive on PATH is a HARD failure, not a warning. A warning here
# guaranteed the user would later report "hive: command not found" and
# need another debugging round.
if ! ensure_npm_global_path hive; then
    print_error "hive CLI installed but NOT on PATH."
    echo ""
    NPM_PREFIX="$(npm config get prefix 2>/dev/null || echo '~/.npm-global')"
    echo "Recovery:"
    echo "  1. Add this to your shell rc (~/.zshrc or ~/.bash_profile):"
    echo "     export PATH=\"${NPM_PREFIX}/bin:\$PATH\""
    echo "  2. Reload shell:  source ~/.zshrc  (or open a new terminal)"
    echo "  3. Verify:        hive --version"
    echo "  4. Resume setup:  ./setup.sh --resume"
    trap - INT TERM ERR
    exit 1
fi
print_success "hive CLI installed (try: hive help)"

    state_save 9a
else
    print_success "Step 9a/10: Install, build & link (already complete, skipping)"
fi

# ============================================================
# Step 9b: Start & Verify
# ============================================================

if ! step_done 9b; then
    CURRENT_STEP="9b"
    print_step "9b/10" "Starting & Verifying"

# Start House MD
echo "Starting House MD..."
pm2 delete house-md --silent 2>/dev/null || true
if ! pm2 start dist/index.js --name house-md -- --agent house-md; then
    print_error "pm2 start house-md failed."
    echo ""
    echo "PM2 daemon may not be running. Try:"
    echo "  pm2 list           # confirm pm2 is responsive"
    echo "  pm2 kill && pm2 resurrect    # reset pm2 if hung"
    echo ""
    echo "Then re-run: ./setup.sh --resume"
    trap - INT TERM ERR
    exit 1
fi

# J.1.0.6 — Register ALL ecosystem daemons. ecosystem.config.cjs defines:
#   - hive-runner    (delegation/wake/boot-announce — added v1.3.0)
#   - hive-dashboard (Express server on 0.0.0.0:7777 — added v1.5.0)
# Both must start on fresh install. pm2 startOrReload is idempotent;
# --update-env picks up HIVE_DASHBOARD_TOKEN written to .env by install.sh.
if [ -f ecosystem.config.cjs ]; then
    echo "Starting ecosystem daemons (hive-runner + hive-dashboard)..."
    pm2 startOrReload ecosystem.config.cjs --update-env
    print_success "hive-runner + hive-dashboard registered"
fi

pm2 save

# --- Post-start health check ---
# v1.5.3 — longer wait. 3 seconds was racing with house-md's Discord login.
echo "Verifying House MD is running..."
sleep 6

# v1.5.7 — robust health check.
# Previous version used `except:` (bare) which catches SystemExit, so when
# python called sys.exit(0) after printing 'online', the except branch
# caught its own exit and printed 'error' too. Result: PM2_STATUS contained
# "online\nerror" — exact-match "online" failed, valid installs reported as
# broken. Switched to for/else + break (no sys.exit needed) and narrowed
# `except` to Exception (which does NOT catch SystemExit). Also piped
# through `head -n1` as defense-in-depth against any future multi-line drift.
PM2_STATUS=$(pm2 jlist 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    for p in data:
        if p.get('name') == 'house-md':
            print(p.get('pm2_env', {}).get('status', 'unknown'))
            break
    else:
        print('not_found')
except Exception:
    print('error')
" 2>/dev/null | head -n1 || echo "error")

STEP_9_OK=false
if [ "$PM2_STATUS" = "online" ]; then
    print_success "House MD is running"
    STEP_9_OK=true
    touch /tmp/.hive-setup-step9-ok
else
    print_error "House MD not online (pm2 jlist status: $PM2_STATUS)"
    echo ""
    echo "=== pm2 list (is house-md tracked?) ==="
    pm2 list 2>&1 || true
    echo ""
    echo "=== pm2 logs house-md (last 30 lines, what's it crashing on?) ==="
    pm2 logs house-md --lines 30 --nostream 2>&1 || true
    echo ""
    echo "=== rogue process check (running OUTSIDE pm2?) ==="
    ps aux | grep -E "(dist/index.js.*house-md|--agent house-md)" | grep -v grep || echo "  (none — house-md is not running)"
    echo ""
    echo "Common causes when status is:"
    echo "  errored     → Claude OAuth missing. Run: claude setup-token (NOT 'claude config set api-key')"
    echo "              → Or: 'Credit balance too low' — same fix"
    echo "              → Or: bot token invalid in .env"
    echo "              → Or: #house-md channel not yet created in Discord"
    echo "  not_found   → pm2 start succeeded but process died before health-check sample"
    echo "              → Logs above will show the exact crash reason"
    echo ""
    echo "Once fixed, resume with:  ./setup.sh --resume"
    echo "(resume will skip Step 9a and retry start + verification only)"
fi

if [ "$STEP_9_OK" = true ]; then
    state_save 9b
else
    trap - INT TERM ERR
    exit 1
fi
else
    print_success "Step 9b/10: Start & verify (already complete, skipping)"
fi

# ============================================================
# Step 10: Boot Persistence
# ============================================================
#
# pm2 save captures the current running process list.
# pm2 startup emits a one-line elevated-permission command that installs a
# launchd agent so PM2 (and all your agents) restart automatically after a
# reboot, logout, or sleep. Without this step, your agents die the first time
# your Mac restarts and never come back — the single silent failure that has
# killed the most Hives.
#
# Flow: we can't run the sudo command for the user (wizard doesn't hold Mac
# passwords) AND we can't wait at a `read` prompt while the user runs it
# (stdin is blocked — pasted text lands in the read, not a shell). So we use
# the existing resume infrastructure: print the command, exit, let the user
# run it in a real shell, then re-run `./setup.sh --resume` which verifies
# and marks this step done.

if ! step_done 10; then
    CURRENT_STEP=10
    print_step "10/10" "Boot Persistence"

    # Save current process list so PM2 can restore it on boot
    echo "Saving current process list..."
    if pm2 save >/dev/null 2>&1; then
        print_success "Process list saved"
    else
        print_warning "pm2 save returned non-zero (continuing)"
    fi

    # --- Plist state matrix ---
    # The plist can be in one of 5 states:
    #   1. Absent               → install from scratch (hand off sudo command)
    #   2. Present + correct    → success, state_save 10
    #   3. Present + wrong User → error, prompt unstartup + reinstall, exit 1
    #   4. Present + wrong PM2  → error, prompt unstartup + reinstall, exit 1
    #   5. Present + corrupt    → treat as absent, prompt unstartup + reinstall
    #
    # We do NOT check `launchctl list` — when pm2 startup runs the load command
    # under sudo, launchd registers the agent in root's session, not the user's,
    # so `launchctl list | grep pm2` returns empty in the user's terminal even
    # though the plist is correctly installed. On next login, launchd auto-loads
    # the plist from ~/Library/LaunchAgents in the user session via RunAtLoad.
    #
    # The content check (UserName + PM2_HOME) catches paste truncation — e.g. a
    # command that was pasted as `--hp /Users/jarvi` instead of `/Users/jarvis`
    # writes a syntactically valid plist that will silently fail at boot.
    PLIST_FOUND=$(ls "$HOME/Library/LaunchAgents/"pm2.*.plist 2>/dev/null | head -1)
    PLIST_OK=false
    if [ -n "$PLIST_FOUND" ]; then
        # Attempt to extract fields; if plutil fails (corrupt/truncated file),
        # treat as absent so the next branch tries again from scratch.
        PLIST_USER=$(plutil -extract UserName raw -o - "$PLIST_FOUND" 2>/dev/null) || true
        PLIST_HOME=$(plutil -extract EnvironmentVariables.PM2_HOME raw -o - "$PLIST_FOUND" 2>/dev/null) || true
        if [ -z "$PLIST_USER" ] && [ -z "$PLIST_HOME" ]; then
            # Both extractions failed — file is corrupt/unreadable
            print_warning "Plist exists but appears corrupt (plutil couldn't parse it)."
            echo "  Path: $PLIST_FOUND"
            echo ""
            echo "Fix with these steps, then re-run this wizard:"
            echo ""
            echo -e "  ${CYAN}pm2 unstartup launchd${NC}"
            echo -e "  ${CYAN}<re-run the pm2 startup command>${NC}"
            echo -e "  ${CYAN}./setup.sh --resume${NC}"
            echo ""
            trap - INT TERM ERR
            exit 1
        fi
        if [ "$PLIST_USER" = "$USER" ] && [ "$PLIST_HOME" = "$HOME/.pm2" ]; then
            PLIST_OK=true
        fi
    fi

    if [ "$PLIST_OK" = true ]; then
        print_success "Boot persistence installed"
        echo "  Plist: $PLIST_FOUND"
        echo "  UserName=$PLIST_USER, PM2_HOME=$PLIST_HOME"
    elif [ -n "$PLIST_FOUND" ]; then
        # Plist exists but content is wrong — most likely a paste truncation
        print_error "Plist is present but looks wrong:"
        echo "  Path:      $PLIST_FOUND"
        echo "  UserName=$PLIST_USER (expected $USER)"
        echo "  PM2_HOME=$PLIST_HOME (expected $HOME/.pm2)"
        echo ""
        echo "This usually means a paste glitch truncated the command."
        echo "Fix with these three steps, then re-run this wizard:"
        echo ""
        echo -e "  ${CYAN}pm2 unstartup launchd${NC}"
        echo -e "  ${CYAN}<re-run the pm2 startup command, carefully checking the full paste>${NC}"
        echo -e "  ${CYAN}./setup.sh --resume${NC}"
        echo ""
        trap - INT TERM ERR
        exit 1
    else
        # Not yet installed. Capture the pm2 startup command and hand off to user.
        echo "Generating startup command..."
        PM2_STARTUP_OUTPUT=$(pm2 startup 2>&1 || true)
        SUDO_CMD=$(echo "$PM2_STARTUP_OUTPUT" | grep -E '^sudo env PATH=.*pm2 startup' | head -1)

        if [ -z "$SUDO_CMD" ]; then
            print_warning "Couldn't auto-parse pm2 startup output. Raw output below:"
            echo ""
            echo "$PM2_STARTUP_OUTPUT"
            echo ""
            echo "Copy the line starting with ${BOLD}sudo env PATH=${NC}, run it in any terminal,"
            echo "then re-run this wizard:"
            echo ""
            echo -e "  ${CYAN}./setup.sh --resume${NC}"
            echo ""
        else
            SETUP_DIR=$(pwd)
            echo ""
            echo -e "${BOLD}━━━ ONE MORE STEP — run this yourself ━━━${NC}"
            echo ""
            echo "To make your agents survive Mac restarts, copy this command, paste"
            echo "it into any terminal (here or a new tab), and enter your Mac password"
            echo "when prompted:"
            echo ""
            echo -e "${CYAN}${SUDO_CMD}${NC}"
            echo ""
            echo "When it finishes (you'll see several [PM2] lines ending with"
            echo -e "${GREEN}[v] Command successfully executed${NC}), come back and run:"
            echo ""
            echo -e "  ${CYAN}cd ${SETUP_DIR} && ./setup.sh --resume${NC}"
            echo ""
            echo "Setup will verify it worked and finish up."
            echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
            echo ""
        fi

        # Do NOT state_save 10 — next resume will re-run Step 10 and verify.
        # Clear the interrupt trap so exit 0 doesn't trigger the "interrupted" path.
        trap - INT TERM ERR
        exit 0
    fi

    # Single gate for state_save 10 — only reached when plist is verified correct.
    if [ "$PLIST_OK" = true ]; then
        state_save 10
    fi
else
    print_success "Step 10/10: Boot persistence (already complete, skipping)"
fi

# All steps complete — clear state file so future runs start fresh.
state_clear
trap - INT TERM ERR

# ============================================================
# Done
# ============================================================

if [ -f /tmp/.hive-setup-step9-ok ]; then
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}${BOLD}        🐝  Hive is ready!  🐝            ${NC}${CYAN}║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
    echo ""
    echo "House MD is online in your Discord server."
    echo "Go to the #house-md channel and say hello."
    echo ""
    echo "House will walk you through building your first agent."
    echo ""
else
    echo ""
    echo -e "${YELLOW}╔══════════════════════════════════════════╗${NC}"
    echo -e "${YELLOW}║${NC}${BOLD}  Setup completed with warnings           ${NC}${YELLOW}║${NC}"
    echo -e "${YELLOW}╚══════════════════════════════════════════╝${NC}"
    echo ""
    echo "House MD didn't connect on first try."
    echo "Diagnose with:"
    echo -e "  ${CYAN}hive doctor${NC}"
    echo -e "  ${CYAN}pm2 logs house-md --lines 50${NC}"
    echo ""
    echo "Once fixed, House MD should auto-recover (PM2 restart)."
    echo ""
fi

if [ -f /tmp/.hive-setup-codex-installed ]; then
    echo "Codex reminder: run 'codex' in your terminal to sign in."
    echo ""
fi

echo -e "${BOLD}Quick reference:${NC}"
echo "  hive status             — See running agents"
echo "  hive logs house-md      — View House MD logs"
echo "  hive restart house-md   — Restart House MD"
echo "  hive doctor             — Run health checks"
echo "  hive help               — See all commands"
echo ""
echo "Your Hive lives at: $(pwd)"
echo ""

# Clean up flag files
rm -f /tmp/.hive-setup-step9-ok
rm -f /tmp/.hive-setup-codex-installed

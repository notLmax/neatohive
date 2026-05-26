#!/usr/bin/env bash
set -euo pipefail

# v1.5.23 — step-by-step diagnostic logging + force-reapply mode.
#
# Invocation:
#   ./tailscale-expose.sh                 — idempotent: only runs `tailscale serve`
#                                            if not already configured for our target.
#   FORCE_REAPPLY=1 ./tailscale-expose.sh  — resets any existing serve config first,
#                                            then re-applies. Use when the current
#                                            config is stuck or stale.
#
# Output is intentionally verbose so doctors can diagnose silent failures.

LOCAL_TARGET="http://localhost:7777"
ALT_LOCAL_TARGET="http://127.0.0.1:7777"
FORCE_REAPPLY="${FORCE_REAPPLY:-0}"

log() {
  printf '%s\n' "$*"
}

extract_dns_name() {
  local status_json=$1
  local dns_name=""

  if command -v jq >/dev/null 2>&1; then
    dns_name=$(printf '%s\n' "${status_json}" | jq -r '.Self.DNSName // ""' 2>/dev/null || true)
  elif command -v python3 >/dev/null 2>&1; then
    dns_name=$(STATUS_JSON="${status_json}" python3 - <<'PY'
import json
import os

try:
    data = json.loads(os.environ.get("STATUS_JSON", ""))
except Exception:
    data = {}

print(((data.get("Self") or {}).get("DNSName")) or "")
PY
)
  fi

  if [ -z "${dns_name}" ]; then
    dns_name=$(tailscale status --self=true 2>/dev/null | awk 'NR==1 { print $2; exit }' || true)
  fi

  printf '%s\n' "${dns_name%.}"
}

extract_serve_target() {
  local serve_json=$1

  if command -v jq >/dev/null 2>&1; then
    SERVE_JSON="${serve_json}" jq -r '
      [(.Web // {})[]?.Handlers["/"]?.Proxy | strings][0] // ""
    ' 2>/dev/null <<<"${serve_json}" || true
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    SERVE_JSON="${serve_json}" python3 - <<'PY'
import json
import os

try:
    data = json.loads(os.environ.get("SERVE_JSON", ""))
except Exception:
    data = {}

for web_target in (data.get("Web") or {}).values():
    handlers = (web_target or {}).get("Handlers") or {}
    proxy = (handlers.get("/") or {}).get("Proxy")
    if isinstance(proxy, str) and proxy:
        print(proxy)
        raise SystemExit(0)

print("")
PY
    return
  fi

  printf '%s\n' ""
}

# ── Step 1: tailscale CLI availability ──

log "[tailscale-expose] step 1/5: checking tailscale CLI availability..."
if ! command -v tailscale >/dev/null 2>&1; then
  log "    FAIL: tailscale CLI not found — install at https://tailscale.com/download"
  log "[tailscale-expose] tailscale CLI not found — skipping (install at https://tailscale.com to enable remote access)"
  exit 0
fi
log "    OK: tailscale found at $(command -v tailscale)"

# ── Step 2: tailscale backend state ──

log "[tailscale-expose] step 2/5: checking tailscale backend state..."
status_json=$(tailscale status --json 2>/dev/null || true)
if ! printf '%s\n' "${status_json}" | grep -q '"BackendState"[[:space:]]*:[[:space:]]*"Running"'; then
  log "    FAIL: backend not running — run 'tailscale up' or 'tailscale login'"
  log "[tailscale-expose] tailscale not running — run 'tailscale login' to enable remote access"
  exit 0
fi
log "    OK: backend running"

# ── Step 3: discover DNS name + current serve config ──

log "[tailscale-expose] step 3/5: inspecting current serve config..."
dns_name=$(extract_dns_name "${status_json}")
serve_json=$(tailscale serve status --json 2>/dev/null || printf '{}\n')
serve_target=$(extract_serve_target "${serve_json}")

url=""
if [ -n "${dns_name}" ]; then
  url="https://${dns_name}/"
fi

if [ -n "${dns_name}" ]; then
  log "    Node DNS name: ${dns_name}"
else
  log "    WARN: could not extract Node DNS name (continuing anyway)"
fi

if [ -z "${serve_target}" ]; then
  log "    No existing tailscale serve target configured"
elif [ "${serve_target}" = "${LOCAL_TARGET}" ] || [ "${serve_target}" = "${ALT_LOCAL_TARGET}" ]; then
  log "    Existing serve target matches our target: ${serve_target}"
  if [ "${FORCE_REAPPLY}" = "1" ]; then
    log "    FORCE_REAPPLY=1 — will reset and re-apply"
  else
    if [ -n "${url}" ]; then
      log "[tailscale-expose] already exposed at ${url}"
    else
      log "[tailscale-expose] already exposed"
    fi
    log "    (idempotent — pass FORCE_REAPPLY=1 to reset and re-apply)"
    exit 0
  fi
else
  log "    Existing serve target points elsewhere: ${serve_target}"
  if [ "${FORCE_REAPPLY}" = "1" ]; then
    log "    FORCE_REAPPLY=1 — will reset and override with our target"
  else
    log "[tailscale-expose] WARNING: tailscale serve :443 already routes a different service — not overwriting. Run 'tailscale serve --bg --https=8443 http://localhost:7777' manually if you want a non-standard port, or run with FORCE_REAPPLY=1 to override."
    exit 0
  fi
fi

# ── Step 4: reset existing config if force-reapply ──

if [ "${FORCE_REAPPLY}" = "1" ] && [ -n "${serve_target}" ]; then
  log "[tailscale-expose] step 4/5: resetting existing serve config..."
  reset_output=$(tailscale serve reset 2>&1 || true)
  if [ -n "${reset_output}" ]; then
    printf '    %s\n' "${reset_output}"
  fi
  log "    OK: existing config cleared"
else
  log "[tailscale-expose] step 4/5: (no reset needed)"
fi

# ── Step 5: apply tailscale serve --bg --https=443 ──

log "[tailscale-expose] step 5/5: applying 'tailscale serve --bg --https=443 ${LOCAL_TARGET}'..."
serve_output=""
serve_exit=0
serve_output=$(tailscale serve --bg --https=443 "${LOCAL_TARGET}" 2>&1) || serve_exit=$?

if [ -n "${serve_output}" ]; then
  printf '    %s\n' "${serve_output}"
fi

if [ "${serve_exit}" -ne 0 ]; then
  log "    FAIL: tailscale serve returned exit ${serve_exit}"
  log "[tailscale-expose] FAILED to apply tailscale serve (exit ${serve_exit}). Check tailnet admin console:"
  log "    1. HTTPS certificates enabled? (admin -> DNS -> MagicDNS)"
  log "    2. Tailscale serve permission granted to this node?"
  log "    3. Run 'tailscale serve --bg --https=443 http://localhost:7777' manually for full error output."
  exit "${serve_exit}"
fi
log "    OK: tailscale serve returned 0"

# Verify reachability — best-effort, doesn't fail the script if curl is unavailable
if [ -n "${url}" ] && command -v curl >/dev/null 2>&1; then
  log "    Verifying reachability at ${url} ..."
  http_status=$(curl -k -s -o /dev/null -w '%{http_code}' --max-time 10 "${url}" 2>/dev/null || echo "000")
  if [ "${http_status}" = "200" ] || [ "${http_status}" = "301" ] || [ "${http_status}" = "302" ]; then
    log "    OK: HTTP ${http_status} from ${url}"
  elif [ "${http_status}" = "000" ]; then
    log "    WARN: could not reach ${url} (curl timed out or DNS not yet propagated)"
    log "    Tailscale's HTTPS cert provisioning may still be in progress. Retry in 30-60s."
  else
    log "    WARN: ${url} returned HTTP ${http_status} (expected 200/301/302)"
    log "    Dashboard may not yet be running on localhost:7777, or cert provisioning is still in progress."
  fi
fi

if [ -n "${url}" ]; then
  log "[tailscale-expose] exposed at ${url}"
else
  log "[tailscale-expose] exposed dashboard on tailscale serve :443"
fi

---
name: wizard-troubleshoot
description: Diagnose and fix Hive setup wizard failures. Use when the owner reports a setup error, a stuck wizard, a coworker can't finish setup, or any symptom involving `./setup.sh` not completing.
---

# Setup Wizard Troubleshooting

When someone's setup wizard breaks, follow this playbook. Your job is to get them unstuck with minimum friction — no re-cloning, no starting from scratch unless genuinely necessary.

---

## Protocol

### Step 1 — Always run the doctor first

The Hive CLI ships with a setup-specific diagnostic:

```bash
cd ~/neato-hive && hive doctor --fix-setup
```

This checks every setup artifact (`.env`, `.setup-state`, config.yaml allowed_paths, Claude/gcloud/op CLIs, PM2, build artifacts) and offers interactive fixes per failure.

**Always ask the user to run this first** and paste the output. Most known issues are caught here.

### Step 2 — If the doctor flags an issue with a fix, apply it

Walk the user through the `[y]` prompts. The doctor's fixes are safe by design (non-destructive, interactive confirmation).

### Step 3 — If the doctor doesn't catch it, match against the playbook below

If a known symptom matches, apply the fix. If it's new, diagnose from first principles.

### Step 4 — After resolving a new issue, update this skill

Append the new symptom/fix to the Playbook section. Then tell House MD's owner so they can open a PR upstream to add the case to `hive doctor --fix-setup` as well.

---

## Playbook — Known Issues

### 1. gcloud virtualenv bootstrap failure

**Symptom (user output contains):**
```
Error: Failure while executing; /usr/bin/env ... gcloud config virtualenv create ... exited with 1.
ERROR: (gcloud.config.virtualenv.create) virtualenv: command not found
```

Often accompanied by: `WARNING: Python 3.9.x is no longer officially supported by the Google Cloud CLI`

**Root cause:** Homebrew's bundled Python 3.13 doesn't ship the `virtualenv` pip package by default. gcloud's Cask post-install hook shells out to `virtualenv` and fails.

**Fix:**
```bash
/opt/homebrew/opt/python@3.13/libexec/bin/python -m pip install --user virtualenv
brew reinstall --cask gcloud-cli
```

Then re-run the wizard: `./setup.sh --resume`

**Auto-detected:** Yes, by `hive doctor --fix-setup`.

---

### 2. Linux gws install points at wrong project (pre-v1.1.5)

**Symptom:** Wizard installed something called `gws` but commands like `gws drive files list` fail with a completely different CLI's help text (git workspace manager).

**Root cause:** Before v1.1.5, Linux install path pointed at `nicholasgasior/gws` — a Python-based Git workspace tool, not Google Workspace.

**Fix:** Uninstall the wrong tool, install the real one from:
```
https://github.com/googleworkspaceplatform/google-workspace-cli/releases
```

**Auto-detected:** Partial — `hive doctor --fix-setup` flags missing gws and offers `brew install googleworkspace-cli` on macOS.

---

### 3. ANTHROPIC_API_KEY conflict

**Symptom (agent logs):**
```
Credit balance too low
```
or
```
Claude authenticated with API key, not subscription
```

**Root cause:** User has `ANTHROPIC_API_KEY` in `~/.zshrc` / `~/.bashrc` / environment. The SDK picks that up over `claude setup-token`.

**Fix:**
```bash
# Remove from shell profiles
grep -v ANTHROPIC_API_KEY ~/.zshrc > /tmp/zshrc.new && mv /tmp/zshrc.new ~/.zshrc
grep -v ANTHROPIC_API_KEY ~/.bashrc > /tmp/bashrc.new && mv /tmp/bashrc.new ~/.bashrc 2>/dev/null || true
unset ANTHROPIC_API_KEY
claude setup-token
# Open new terminal and re-run setup or restart agents
```

**Auto-detected:** Yes — both `setup.sh` and `hive doctor` catch this.

---

### 4. Discord bot token invalid / malformed

**Symptom:** House MD starts but Discord shows `DISALLOWED_INTENTS` or `TOKEN_INVALID`.

**Root cause:**
- Missing privileged intents (Presence / Server Members / Message Content must all be ON in Developer Portal)
- Token was regenerated after user pasted the old one
- User pasted the Application ID instead of the Bot Token

**Fix:**
1. Go to https://discord.com/developers/applications → pick the bot
2. **Bot** tab → **Reset Token** → copy the NEW token
3. Same page → scroll to **Privileged Gateway Intents** → turn on all three toggles → **Save Changes**
4. Update `.env`:
   ```bash
   sed -i.bak "s|^DISCORD_BOT_TOKEN_HOUSE_MD=.*|DISCORD_BOT_TOKEN_HOUSE_MD=<new-token>|" .env
   pm2 restart house-md
   ```

**Auto-detected:** No — token format check in wizard catches obvious typos but not intent misconfiguration.

---

### 5. `hive` CLI not found after setup

**Symptom:** `hive: command not found`

**Root cause:** `npm link` put the binary at `$(npm config get prefix)/bin/hive`, which isn't in PATH.

**Fix:**
```bash
export PATH="$(npm config get prefix)/bin:$PATH"
# Persist:
echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.zshrc
```

Or open a new terminal — the wizard adds the PATH export automatically.

**Auto-detected:** Partial — `setup.sh`'s `ensure_npm_global_path` helper handles this during setup, but if PATH edit was rejected it won't persist.

---

### 6. `.setup-state` mismatch on resume

**Symptom:** Wizard says "Setup state is from wizard version X.Y.Z; current is A.B.C. Forcing fresh start."

**Root cause:** User updated Hive (git pull / hive update) between setup runs. Resuming would run new step logic against old checkpoint data — unsafe.

**Fix:** Let it restart. The wizard will re-run completed steps (which are idempotent — they detect when things are already installed/configured and no-op).

**Auto-detected:** Yes — wizard handles this automatically.

---

### 7. Port conflicts (PM2 / Discord agent process can't start)

**Symptom:** `pm2 logs house-md` shows `EADDRINUSE` or `listen EACCES`.

**Root cause:** Agents don't bind to ports directly — but PM2 daemon does (default 2019). Another PM2 instance from a prior user (or Docker containers) may have claimed it.

**Fix:**
```bash
pm2 kill           # Stop PM2 entirely
pm2 resurrect      # Restart saved processes
# If still failing:
lsof -iTCP:2019 -sTCP:LISTEN    # Find culprit
```

**Auto-detected:** No — rare, user should report if they see it.

---

### 8. 1Password service account can't see vault

**Symptom:** `op read` commands return "no such vault" or `op vault list` doesn't show the vault.

**Root cause:** Service account was created but not granted access to the specific vault.

**Fix:**
1. Sign in at `https://<subdomain>.1password.com`
2. **Developer Tools** → **Service Accounts** → pick the `Hive-Agents` account (or whatever name)
3. Under **Vault Access**, grant **Read + Write** on the Hive vault
4. Back in terminal: `OP_SERVICE_ACCOUNT_TOKEN=$(grep OP_SERVICE_ACCOUNT_TOKEN .env | cut -d= -f2-) op vault list` — vault should now appear

**Auto-detected:** Yes — `hive doctor --fix-setup` flags this and prints the remediation steps.

---

### 9. Homebrew cask install fails on M-series Mac with Python 3.9 deprecation

**Symptom:**
```
WARNING: Python 3.9.x is no longer officially supported by the Google Cloud CLI
```

This is *just* a warning — the actual failure is usually #1 above (virtualenv). But if the user has `/usr/bin/python3` (system Python 3.9) ahead of Homebrew's 3.13 in PATH, gcloud may pick the deprecated one.

**Check:** `which python3` → should be `/opt/homebrew/bin/python3`, not `/usr/bin/python3`.

**Fix:** If the wrong Python is first:
```bash
echo 'export PATH="/opt/homebrew/bin:$PATH"' >> ~/.zshrc
# Open new terminal
```

**Auto-detected:** No.

---

## Diagnostic Info to Request

When a user reports a wizard failure not in the playbook, ask for:

1. **Full error output** — not just the tail; the wizard's prior output often reveals which step failed
2. **Operating system** — `sw_vers` (macOS) or `uname -a` (Linux)
3. **Shell** — `echo $SHELL`
4. **Homebrew state** — `brew --version` and `brew doctor | head -30`
5. **Python state** — `which python3`, `python3 --version`
6. **Node state** — `which node`, `node --version`
7. **Whether fresh Mac or migrated** — Migration Assistant restores can leave stale Pythons/Nodes
8. **Exact step where wizard stopped** — ask them to run `cat ./.setup-state` if present

With these in hand, diagnose from first principles before guessing.

---

## When to Recommend Starting Over

Rare. Only when:
- State file is corrupted in a way that can't be edited by hand
- `.env` contains actual secrets from a prior failed setup that user wants to nuke
- User explicitly wants a clean install

In that case:
```bash
rm -f ./.setup-state ./.env
./setup.sh --fresh
```

Everything else — fix in place.

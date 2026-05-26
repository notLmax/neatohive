# CREDENTIALS.md — 1Password Reference

All credentials live in **1Password** — one vault per Hive installation. The vault name is configured in `.env` as `OP_VAULT_NAME`.

The `op` CLI is authenticated via `OP_SERVICE_ACCOUNT_TOKEN` (already in `.env`, loaded into every agent process by the bootstrap).

---

## Architecture

**One vault per Hive installation, shared across all agents in that Hive.**

- Every agent you build (Vision, Miss Minutes, Jarvis, etc.) reads from the same vault.
- Different employees running Hive on their own machines get their own vaults.
- Cross-employee leakage is impossible — each employee's service account token only has access to their own vault.
- Cross-agent access inside your own Hive is intentional — you own them all.

If you ever want stricter per-agent isolation, you can create multiple vaults and multiple service accounts, then set `OP_SERVICE_ACCOUNT_TOKEN_<AGENT_NAME>` in `.env` (matches the Discord bot token pattern). Not required for typical use.

---

## Rules

1. **Every new credential goes into 1Password first**, then its reference goes into the agent files that need it.
2. **Never commit plaintext secrets** to agent files, memory files, or git.
3. **Never paste secrets in Discord** — they're retained forever and the whole hive reads Discord.
4. **Temp files in `/tmp`** get wiped on reboot. That's fine — agents fetch fresh.
5. **If a credential changes** (rotation), update the 1P item once. All agents auto-pick up new values next call.

---

## Patterns

### Simple API keys / tokens (text, single-field)

Fetch with `op read`:

```bash
op read "op://$OP_VAULT_NAME/<ITEM TITLE>/credential"
```

Example:
```bash
TOKEN=$(op read "op://$OP_VAULT_NAME/My Service API Token/credential")
curl -s "https://api.example.com/v2/resource" -H "Authorization: Bearer $TOKEN"
```

### JSON credential documents (service accounts, multi-field)

Fetch to a temp file with `op document get`:

```bash
op document get "<ITEM TITLE>" --vault "$OP_VAULT_NAME" --out-file /tmp/<shortname>.json
```

Example — GCP service account:
```bash
op document get "GCP SA — data-reader" --vault "$OP_VAULT_NAME" --out-file /tmp/gcp-sa.json
export GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp-sa.json
gcloud auth activate-service-account --key-file=$GOOGLE_APPLICATION_CREDENTIALS
```

### Multi-field credentials (OAuth clients, structured)

Use `op item get --format json` and parse:

```bash
CLIENT_ID=$(op read "op://$OP_VAULT_NAME/My OAuth Client/username")
CLIENT_SECRET=$(op read "op://$OP_VAULT_NAME/My OAuth Client/credential")
# Or full JSON including custom fields:
op item get "My OAuth Client" --vault "$OP_VAULT_NAME" --format json
```

---

## Setup

The setup wizard (`./setup.sh`) walks you through:

1. Creating the vault in the 1Password web UI
2. Creating a service account scoped to that vault
3. Capturing the token into `.env`

If you skipped that step during setup, do it manually:

1. Sign in to your 1Password web UI (`https://<your-subdomain>.1password.com`)
2. Create a new vault. Suggested name: `<YourFirstName>-Hive`
3. Go to **Integrations → Service Accounts** (or **Developer Tools**)
4. Create a service account named `Hive-Agents`, grant it **Read + Write** access to the new vault
5. Copy the token (starts with `ops_...`)
6. Add to `.env`:
   ```
   OP_SERVICE_ACCOUNT_TOKEN=ops_...
   OP_VAULT_NAME=YourFirstName-Hive
   ```
7. Restart agents: `pm2 restart all`

---

## Troubleshooting

**`op` commands say "No accounts configured"**: The `OP_SERVICE_ACCOUNT_TOKEN` env var isn't loaded into the agent's shell. Verify it's in `.env` and restart the agent.

**Token validates but can't see items**: The service account may have been granted access to a different vault than `OP_VAULT_NAME`. Check in the 1Password web UI under Service Accounts.

**Agent needs a new credential**: Ask House MD to add the item. House MD can write to 1P using the same service account token.

---

*Per-Hive file. Update it with your own credential catalog as you add them.*

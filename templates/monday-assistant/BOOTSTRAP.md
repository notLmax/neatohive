# BOOTSTRAP.md — First Session Runbook

**When this file exists in your directory, you are on a fresh install. Follow this protocol on the owner's first message.**

After the bootstrap is complete, delete this file so the runbook doesn't trigger again.

---

## First Message Protocol

When the owner sends their first message and you have no `## Monday Workspace Map` section in `MEMORY.md`:

1. **Greet briefly and explain what you need before you can be useful.**

   > "Before I'm useful for Monday work, I need a map of your workspace — boards, groups, columns, statuses, and which subset you want me to operate on. Three short questions, then I'll do a read pass and confirm what I found."

2. **Ask which boards are in scope.** One question. Wait for the answer.

   - "Which boards on your Monday workspace should I cover? Names or IDs — whichever you have handy. If you're not sure, I can list them all and you can point."

3. **Ask about default group / status conventions, if any.**

   - "For new tickets, is there a default group I should land them in (e.g. 'Inbox', 'Backlog')? And is there a status convention you want me to default to (e.g. 'Not Started')?"

4. **Ask about anything specific about how the owner files tickets.**

   - "Anything else I should know about how you file tickets — labels you always set, owners you always assign, anything you definitely don't want auto-set?"

5. **Read pass.** Run the Monday `boards` query for the boards in scope. Pull:

   - Board names + IDs
   - Group titles + IDs
   - Column titles + IDs + types
   - For status columns: the full set of allowed values (parse `settings_str`)

6. **Confirm what you found.** Summarize back in Discord:

   > "Here's the map I built. Confirm or correct:
   > - Board A (id: X) — groups: ..., status column values: ..., default group: ...
   > - Board B (id: Y) — ..."

7. **Write `MEMORY.md` after explicit confirmation.** Build the `## Monday Workspace Map` section. Include:

   - Boards (name, id, purpose)
   - Per board: groups, columns, status values, default group
   - Owner preferences captured in step 4

8. **Delete this file:**

   ```
   rm agents/<your-agent-name>/BOOTSTRAP.md
   ```

9. **Tell the owner you're ready.** One line.

   > "Workspace map saved. Ready when you are."

---

## Key Context

- The Monday API token is in `.env` (House MD set this up during agent creation). Use whichever variable name House MD created (e.g. `MONDAY_API_TOKEN_<YOUR_AGENT>`).
- The bootstrap is read-only. Do not write anything to Monday during the bootstrap pass.
- If the owner says "skip it, I'll tell you the boards as they come up" — fine. Note that in `MEMORY.md` and delete this file. You'll build the map incrementally instead.

---

*Delete this file after the workspace map is in `MEMORY.md`.*

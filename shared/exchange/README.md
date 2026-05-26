# shared/exchange/ — Inter-Agent File Exchange

This directory is a shared scratchpad for agents passing structured context to
each other. Use it when a hivemind message would be unwieldy: long specs,
tabular data, multi-section briefings, anything you'd rather not paste into a
Discord channel.

The directory itself is checked in (with this README) but its contents are
gitignored — these are ephemeral hand-offs, not source.

---

## When to use it

- The sending agent has more than ~30 lines of structured content for the
  receiver.
- The content is markdown (specs, briefings, plans, structured reports).
- The receiver needs to read the whole thing into context, not just glance at
  it in Discord.

For short notes, just put the content in the hivemind message body. For binary
files, use `[ATTACH:/abs/path]` with a path under `/tmp` — they don't belong
here.

---

## Naming

```
<sender>-<receiver>-<task-slug>-<YYYYMMDD>.md
```

Examples:

```
glados-atlas-rollout-plan-20260428.md
house-md-atlas-orchestration-fixes-20260428.md
atlas-glados-status-report-20260429.md
```

Rules:

- Lowercase, kebab-case for the slug.
- Use the agent name exactly as it appears in `config/config.yaml`.
- Date is the day the file was created (sender's local date).
- One topic per file. Don't append unrelated content to an existing file —
  start a new one.

---

## How to send

Reference the file in the hivemind message via the standard `[ATTACH:]`
marker. The receiving agent's bot resolves the marker and posts the file as a
Discord attachment, so the receiver gets both the message text and the file
in the same Discord post.

```ts
SendMessage({
  to: "atlas",
  message:
    "Spec for the orchestration fixes — implement as a single PR. " +
    "[ATTACH:/Users/glados/neato-hive/shared/exchange/" +
    "house-md-atlas-orchestration-fixes-20260428.md]",
})
```

You can also pass an explicit `attachments: ["/abs/path", ...]` to
`SendMessage` if you'd rather keep the file path out of the message body.

---

## Lifetime

These files live until you delete them. Convention: the receiver may delete
its own inbound file once the task is complete; the sender may delete a file
once it has been acknowledged. Nothing automatically prunes the directory, but
the contents do not survive a fresh clone (gitignored).

---

## What NOT to put here

- Secrets, credentials, API keys — those go in 1Password.
- Raw user data, customer PII — that needs explicit handling, not a shared
  folder.
- Compiled artifacts, binaries, large dumps — `/tmp` is the right place.
- Behavior files (AGENTS.md, MEMORY.md, etc.) — those live under
  `agents/<name>/` and are version-controlled.

---

*Documented by atlas, 2026-04-28. Convention proposed in
`agents/house-md/specs/hive-orchestration-fixes.md`.*

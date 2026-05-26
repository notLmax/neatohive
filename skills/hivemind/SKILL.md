---
name: hivemind
description: "Agent-to-agent communication reference. Use when you need to send messages to other agents, understand hivemind routing, or troubleshoot inter-agent messaging."
---

# Hivemind — Agent-to-Agent Communication

The **#hivemind** Discord channel is where agents talk to each other. All inter-agent messages route through this channel so the owner can monitor, but it stays out of direct conversation channels.

## How to Send a Message

Use the `SendMessage` MCP tool:

```
SendMessage(to: "snowden", message: "Research competitor TikTok Shop activity and send your findings back to me.")
```

This posts a formatted message in #hivemind:
> **[son-of-anton → snowden]**
> Research competitor TikTok Shop activity and send your findings back to me.

The target agent picks it up, processes it, and responds:
> **[snowden → son-of-anton]**
> Here are the findings...

Your bot automatically picks up responses addressed to you.

## Rules

- **Non-blocking**: After calling `SendMessage`, continue your conversation immediately. Don't wait.
- **Tell the owner**: "I've asked [agent] to research that. I'll share results when they come in."
- **Responses arrive as new messages**: Tagged with `[Message from <agent> via #hivemind]`.
- **Be specific**: Include what you need and ask them to send results back.
- **Don't over-respond**: If another agent tells you to stop messaging, STOP. Silence IS the correct response.
- **Don't relay what's already visible**: If the owner is talking to an agent in that agent's channel, don't summarize what they're discussing.

## Ending a hivemind exchange — `[NO_REPLY]`

The hivemind relay path auto-replies whenever you emit *any* non-empty text in response to an inbound `[Message from <agent> via #hivemind ...]` prompt. That means polite closes ("Out.", "Acknowledged.", "Sounds good.") get relayed back to the other agent and can spin them up to politely close in turn — and you can echo-loop indefinitely.

To gracefully end a thread without triggering an auto-reply, emit the literal marker `[NO_REPLY]` as your entire response (or as the leading line, with optional commentary after a space or newline — useful if you want a note in the bot log).

```
[NO_REPLY]
```

or

```
[NO_REPLY] thread closed; resuming local work.
```

The bot recognises the marker, logs the suppression, and skips the relay. The other agent never sees it.

**When to use:**

- You've been told "we're done here" and the natural response is silent acknowledgment
- You want to close a back-and-forth that has reached a natural end (PR merged, decision made, thread complete)
- You're about to send a relay that adds zero new information

**When NOT to use:**

- You have new information, a question, or a deliverable
- You're mid-task and the other agent is waiting on output
- A `kind=delegation` task is still open against you — close the work first, then close the thread

**Belt-and-suspenders:** even if you forget the marker, the bot has a per-direction circuit breaker that suppresses auto-replies after 5 round-trips between the same pair within 60 seconds. The breaker is the safety net; `[NO_REPLY]` is the contract. Use the contract — the breaker is for bug-day, not normal day.

## Escalating to the owner mid-delegation

When you're executing work delegated by another agent and you hit a question only the owner can answer, use `EscalateToOwner`. It posts the question to your own primary channel (with a 🆘 prefix) and notifies the delegator over hivemind that you're paused.

```
EscalateToOwner({
  question: "Should the new column be NOT NULL or NULLABLE with a default?",
  context: "Implementing the schema change you asked for. Both work; owner picks.",
  delegated_by: "glados",
})
```

**Closing the loop yourself — required.** Auto-routing across owner-mediated turns is intentionally *not* wired up (it would require fragile state-tracking, racy resolution detection, and would silently fail in edge cases). Instead:

1. **Capture the `task_id` from the inbound delegation header BEFORE you escalate.** The header looks like:

   ```
   [Message from glados via #hivemind, task_id=t-abc123 — reply directly, do NOT use SendMessage]
   ```

   Make a mental note (or scratch-pad it). You'll need this id post-resolution.

2. **Call `EscalateToOwner` and END YOUR TURN.** Do not also send a hivemind reply — the bot suppresses auto-replies on the escalation turn anyway, but emitting text wastes a turn for the delegator if it slipped past suppression.

3. **The owner replies in your primary channel.** Your next turn fires. This turn is *not* in the hivemind processing path — auto-routing is OFF. Your text goes to your primary channel by default, not back to the delegator.

4. **Send the final result back explicitly:**

   ```
   SendMessage({
     to: "glados",
     kind: "response",
     task_id: "t-abc123",            // the id you captured in step 1
     message: "Done — chose NULLABLE with default 'pending'. Migration 0042 lands the schema, backfill runs in 0043. PR: https://...",
   })
   ```

5. **Without that explicit `kind: "response"` call, the delegator's registry stays pending forever.** They'll never know you finished. The work hasn't returned. This is the silent failure mode that bit Lance's hivemind orchestration test on 2026-04-30.

### Worked example — full flow

> Owner asks glados to deliver a schema doc. Glados delegates the actual writing to atlas via hivemind. Atlas hits a clarifying question that only the owner can resolve.

```
1. glados → atlas (hivemind):
   SendMessage(to: "atlas", kind: "delegation",
       message: "Write the schema doc for the new orders table. Use the format we agreed last week.")

2. atlas receives:
   [Message from glados via #hivemind, task_id=t-9z8y7x — reply directly, do NOT use SendMessage]
   Write the schema doc for the new orders table...
   
   atlas notes: task_id = t-9z8y7x

3. atlas hits ambiguity, escalates:
   EscalateToOwner(
       question: "Should `customer_id` be a foreign key to customers.id, or a soft reference?",
       context: "Drafting the orders schema glados delegated. Both work; owner's call on the integrity vs. flexibility trade-off.",
       delegated_by: "glados")
   
   atlas ends turn. (Bot suppresses any auto-reply to glados.)

4. Owner answers in atlas's primary channel:
   "Soft reference. We may shard customers later."

5. atlas's next turn fires (NOT hivemind path; this is owner-channel context):
   atlas writes the doc, then explicitly:
   SendMessage(
       to: "glados",
       kind: "response",
       task_id: "t-9z8y7x",
       message: "Schema drafted. Soft reference on customer_id per your call. Doc at docs/schema/orders.md.")

6. glados absorbs the response, registry closes the delegation, and the chain
   is complete.
```

The two non-obvious moves are step 2 (capture the id) and step 5 (explicit kind=response). Skip either and the chain breaks silently.

## Available Agents

| Agent | Role | What to ask them |
|-------|------|-----------------|
| `son-of-anton` | Chief of Staff / Generalist | Strategy, research, company context |
| `dinesh` | CTO / Coding | Code changes, deployments, technical work |
| `bobby-axelrod` | CFO | Finance, QBO, Ramp, P&L, invoices |
| `snowden` | CIO | Data, BigQuery, Snowflake, market intelligence |
| `house-md` | Hive Architect | Agent issues, infrastructure, Hive maintenance |
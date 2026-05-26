/**
 * hive-tools-server.ts
 * In-process MCP server exposing custom Hive tools to the agent.
 * Uses the Claude Agent SDK's createSdkMcpServer for zero-overhead tool registration.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { cronAdd, cronList, cronListForAgent, cronRemove } from "./cron.js";
import { memorySearch, memoryGet, memoryAppend } from "./memory.js";
import { applyPatch } from "./patch.js";
import { processStart, processList, processLogs, processKill, processSendKeys } from "./process.js";
import {
  sendToAgent,
  sendToChannel,
  sendToChannelById,
  isHivemindProcessing,
  getHivemindProcessingState,
  escalateToOwner,
  MESSAGE_KINDS,
  type MessageKind,
} from "./messaging.js";
import { sendToOwnChannel } from "./own-channel.js";

/**
 * Creates the Hive custom tools MCP server.
 * Pass the agent's behavior directory so memory tools know where to look.
 */
export function createHiveToolsServer(behaviorDir: string, agentName?: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "hive-tools",
    version: "1.0.0",
    tools: [

      // ── Cron ──────────────────────────────────────────────
      tool(
        "CronCreate",
        "Create a scheduled job on a cron schedule. Jobs persist across restarts. " +
        "Two types: 'agent' (default) sends a prompt through your AI session and posts results to Discord. " +
        "'shell' runs a raw shell command. " +
        "Use standard cron expressions (e.g. '*/5 * * * *' for every 5 minutes, '0 9 * * 1' for Mondays at 9am).",
        {
          schedule: z.string().describe("Cron expression (e.g. '0 * * * *' for hourly)"),
          command: z.string().describe("Agent prompt (type=agent) or shell command (type=shell)"),
          description: z.string().describe("Human-readable description of what this job does"),
          type: z.enum(["agent", "shell"]).optional().describe("Job type: 'agent' (default) runs an AI prompt, 'shell' runs a command"),
        },
        async (args) => {
          try {
            const job = cronAdd(agentName ?? "__HIVE_NO_AGENT__", args.schedule, args.command, args.description, args.type ?? "agent");
            return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }] };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
          }
        }
      ),

      tool(
        "CronList",
        "List all scheduled cron jobs with their IDs, schedules, commands, and status.",
        {},
        async () => {
          const jobs = cronListForAgent(agentName ?? "__HIVE_NO_AGENT__");
          if (jobs.length === 0) {
            return { content: [{ type: "text", text: "No cron jobs configured." }] };
          }
          return { content: [{ type: "text", text: JSON.stringify(jobs, null, 2) }] };
        }
      ),

      tool(
        "CronDelete",
        "Delete a scheduled cron job by its ID. Use CronList to find job IDs.",
        {
          id: z.string().describe("The cron job ID (e.g. 'cron-1712345678')"),
        },
        async (args) => {
          const removed = cronRemove(args.id);
          if (removed) {
            return { content: [{ type: "text", text: `Deleted cron job ${args.id}` }] };
          }
          return { content: [{ type: "text", text: `Cron job ${args.id} not found` }], isError: true };
        }
      ),

      // ── Memory ────────────────────────────────────────────
      tool(
        "MemorySearch",
        "Search your MEMORY.md file using keywords. Returns the most relevant entries " +
        "ranked by how many search terms match. Use this to recall facts, preferences, " +
        "or context from previous sessions.",
        {
          query: z.string().describe("Search keywords (e.g. 'font preferences' or 'AC project stack')"),
          topK: z.number().optional().describe("Max results to return (default: 5)"),
        },
        async (args) => {
          const results = memorySearch(behaviorDir, args.query, args.topK ?? 5);
          if (results.length === 0) {
            return { content: [{ type: "text", text: "No matching entries found in MEMORY.md" }] };
          }
          const formatted = results.map(r => `[${r.section}] ${r.content}`).join("\n");
          return { content: [{ type: "text", text: formatted }] };
        }
      ),

      tool(
        "MemoryGet",
        "Get all entries from a specific section of your MEMORY.md file.",
        {
          section: z.string().describe("Section name (e.g. 'Preferences', 'Infrastructure', 'Projects')"),
        },
        async (args) => {
          const entries = memoryGet(behaviorDir, args.section);
          if (entries.length === 0) {
            return { content: [{ type: "text", text: `No entries found in section "${args.section}"` }] };
          }
          const formatted = entries.map(e => `- ${e.content}`).join("\n");
          return { content: [{ type: "text", text: `## ${args.section}\n${formatted}` }] };
        }
      ),

      tool(
        "MemoryAppend",
        "Add a new entry to a section in your MEMORY.md file. Creates the section if it doesn't exist. " +
        "Use this to persist important facts, preferences, or decisions across sessions.",
        {
          section: z.string().describe("Section name to append to (e.g. 'Preferences', 'Infrastructure')"),
          content: z.string().describe("The entry to add (will be formatted as a list item)"),
        },
        async (args) => {
          try {
            memoryAppend(behaviorDir, args.section, args.content);
            return { content: [{ type: "text", text: `Added to ${args.section}: ${args.content}` }] };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
          }
        }
      ),

      // ── Patch ─────────────────────────────────────────────
      tool(
        "FilePatch",
        "Apply multiple search-and-replace edits to a file in one atomic operation. " +
        "ALL hunks must match or the entire patch is rejected — no partial edits. " +
        "Use this when you need to make several related changes to a file at once.",
        {
          filepath: z.string().describe("Absolute path to the file to patch"),
          hunks: z.array(z.object({
            search: z.string().describe("Exact text to find in the file"),
            replace: z.string().describe("Text to replace it with"),
          })).describe("Array of search/replace pairs to apply"),
        },
        async (args) => {
          const result = applyPatch(args.filepath, args.hunks);
          if (result.success) {
            return { content: [{ type: "text", text: `Patched ${result.filepath}: ${result.hunksApplied}/${result.hunksTotal} hunks applied` }] };
          }
          const errText = `Patch failed on ${result.filepath}:\n${result.errors.join("\n")}`;
          return { content: [{ type: "text", text: errText }], isError: true };
        }
      ),

      // ── Process ───────────────────────────────────────────
      tool(
        "ProcessStart",
        "Start a background process and capture its output. Returns a process ID " +
        "you can use to check logs, send input, or kill it. Processes are tracked " +
        "in memory only (lost on agent restart).",
        {
          command: z.string().describe("Command to run (e.g. 'npm run dev')"),
        },
        async (args) => {
          const proc = processStart(args.command);
          return { content: [{ type: "text", text: JSON.stringify({
            id: proc.id,
            pid: proc.pid,
            command: proc.command,
            status: proc.status,
          }, null, 2) }] };
        }
      ),

      tool(
        "ProcessList",
        "List all managed background processes with their status.",
        {},
        async () => {
          const list = processList();
          if (list.length === 0) {
            return { content: [{ type: "text", text: "No managed processes." }] };
          }
          const summary = list.map(p =>
            `${p.id} | ${p.status} | pid:${p.pid} | ${p.command}`
          ).join("\n");
          return { content: [{ type: "text", text: summary }] };
        }
      ),

      tool(
        "ProcessLogs",
        "Get recent output (stdout + stderr) from a managed background process.",
        {
          id: z.string().describe("Process ID (e.g. 'proc-1712345678')"),
          lines: z.number().optional().describe("Number of recent lines to return (default: 50)"),
        },
        async (args) => {
          const logs = processLogs(args.id, args.lines ?? 50);
          return { content: [{ type: "text", text: logs.join("\n") || "(no output)" }] };
        }
      ),

      tool(
        "ProcessKill",
        "Kill a managed background process by its ID.",
        {
          id: z.string().describe("Process ID to kill"),
        },
        async (args) => {
          const killed = processKill(args.id);
          if (killed) {
            return { content: [{ type: "text", text: `Killed process ${args.id}` }] };
          }
          return { content: [{ type: "text", text: `Process ${args.id} not found` }], isError: true };
        }
      ),

      tool(
        "ProcessSendKeys",
        "Send input (keystrokes) to a managed background process's stdin.",
        {
          id: z.string().describe("Process ID"),
          input: z.string().describe("Text to send to stdin (include \\n for Enter)"),
        },
        async (args) => {
          const sent = processSendKeys(args.id, args.input);
          if (sent) {
            return { content: [{ type: "text", text: `Sent input to ${args.id}` }] };
          }
          return { content: [{ type: "text", text: `Failed to send to ${args.id} (not found or no stdin)` }], isError: true };
        }
      ),

      // ── Messaging ─────────────────────────────────────────
      tool(
        "SendMessage",
        "Send a message to another agent via #hivemind. The message appears in the " +
        "hivemind channel where the target agent picks it up. Use this to delegate tasks, " +
        "ask questions, or share information with other agents. The conversation happens " +
        "in the background — you can continue your current conversation immediately.\n\n" +
        "kind: 'delegation' (default) for work requests, 'query' for quick questions, " +
        "'response' for replies (requires task_id from the original delegation). " +
        "'escalation' is reserved for the EscalateToOwner tool — don't use it directly.",
        {
          to: z.string().describe("Target agent name (e.g. 'atlas', 'cave-johnson', 'glados')"),
          message: z.string().describe("Message to send to the other agent"),
          kind: z.enum(["delegation", "response", "escalation", "query"]).optional()
            .describe("Message kind. Defaults to 'delegation'."),
          task_id: z.string().optional()
            .describe("Required when kind='response' — the task id from the original delegation."),
          attachments: z.array(z.string()).optional()
            .describe("Optional list of absolute file paths to attach (in addition to any [ATTACH:] markers in the body)."),
        },
        async (args) => {
          // Block SendMessage during hivemind processing — bot handles response routing
          if (isHivemindProcessing()) {
            const { kind } = getHivemindProcessingState();
            let msg: string;
            if (kind === "request") {
              msg = "SendMessage blocked: you're handling a hivemind request. Your text reply will auto-route back to the sender via #hivemind. No need to call SendMessage.";
            } else if (kind === "response" || kind === "escalation") {
              msg = `SendMessage blocked: this turn is absorbing a [${kind === "response" ? "Response" : "Escalation"}] inbound — that delegation thread is closed and your text reply will NOT auto-route. To send NEW substantive content to another agent, end this turn (emit '[NO_REPLY]' or just stop responding); SendMessage will be callable on the next turn.`;
            } else {
              msg = "SendMessage blocked: hivemind processing active. Try again on the next turn.";
            }
            return { content: [{ type: "text", text: msg }], isError: true };
          }
          const from = agentName || "unknown";
          const kind = (args.kind ?? "delegation") as MessageKind;
          if (!MESSAGE_KINDS.includes(kind)) {
            return { content: [{ type: "text", text: `Failed: unknown kind '${kind}'` }], isError: true };
          }
          const result = await sendToAgent(from, args.to, args.message, {
            kind,
            taskId: args.task_id,
            attachments: args.attachments,
          });
          if (result.success) {
            const idNote = result.taskId ? ` (task ${result.taskId})` : "";
            return { content: [{ type: "text", text: `Message sent to ${args.to} via #hivemind${idNote}. They'll pick it up and respond there.` }] };
          }
          return { content: [{ type: "text", text: `Failed: ${result.error}` }], isError: true };
        }
      ),

      tool(
        "sendToOwnChannel",
        "Post a message to your own primary Discord channel (the one the owner sees). " +
        "This is for explicit, agent-initiated posts — boot announcements, status updates, " +
        "or any message that should bypass the cron/wake auto-post split. " +
        "Only the explicit tool call surfaces the message; wake-mode text replies are NOT auto-posted.",
        {
          message: z.string().describe("The message to post to your primary channel"),
        },
        async (args) => {
          const from = agentName || "unknown";
          const result = await sendToOwnChannel(from, args.message);
          if (result.success) {
            return { content: [{ type: "text", text: `Posted to your primary channel.` }] };
          }
          return { content: [{ type: "text", text: `Failed: ${result.error}` }], isError: true };
        }
      ),

      tool(
        "EscalateToOwner",
        "Surface a question or status to your owner in your primary Discord channel " +
        "when only the owner can answer it. Posts the question with a 🆘 prefix so the " +
        "owner knows it's an escalation, and notifies the delegating agent via #hivemind " +
        "that you're paused (silent-absorb on their side — no spin-up).\n\n" +
        "**When you call this during a hivemind turn, END YOUR TURN.** Do not also send a " +
        "text reply to the delegating agent — your text would auto-route as kind=response " +
        "and spin them up just to read 'I'm asking the owner.' The bot suppresses that " +
        "auto-reply when this tool fires.\n\n" +
        "**The original delegation stays pending — closing it back out is YOUR job.** " +
        "When the owner answers in your primary channel, your next turn fires. Auto-routing " +
        "is OFF for that turn (it's an owner-channel reply, not a hivemind reply). To send " +
        "the final result back to the delegator, you MUST call:\n" +
        "  SendMessage(to: '<delegator>', kind: 'response', task_id: '<the inbound task_id>', message: '<final answer>')\n" +
        "Capture the task_id from your original delegation prompt header BEFORE calling " +
        "this tool — it looks like `[Message from <agent> via #hivemind, task_id=t-abc123 ...]`. " +
        "Without the explicit SendMessage(kind=response), the delegator's registry stays " +
        "stuck waiting forever.\n\n" +
        "Use cases: clarifying questions, decisions only the owner can make (deploy " +
        "approvals, scope changes), status reports the delegator should not handle.",
        {
          question: z.string().describe("The question or status for the owner."),
          context: z.string().describe("1-2 sentence context: what's blocked / why the owner needs to answer."),
          delegated_by: z.string().describe("Name of the agent that delegated the work (e.g. 'glados')."),
        },
        async (args) => {
          // No hivemindProcessingActive check — EscalateToOwner targets the
          // agent's OWN primary channel, not #hivemind. Different transport,
          // no double-post risk. The whole point of this tool is to be
          // callable mid-hivemind-turn so an agent can break out cleanly.
          const executor = agentName || "unknown";
          const result = await escalateToOwner({
            executor,
            delegatedBy: args.delegated_by,
            question: args.question,
            context: args.context,
          });
          if (result.success) {
            const idNote = result.taskId ? ` (task ${result.taskId})` : "";
            const chanNote = result.primaryChannel ? ` in #${result.primaryChannel}` : "";
            return { content: [{ type: "text", text: `Escalation posted to owner${chanNote}${idNote}. ${args.delegated_by} has been notified that you're paused.` }] };
          }
          return { content: [{ type: "text", text: `Failed: ${result.error}` }], isError: true };
        }
      ),
    ],
  });
}

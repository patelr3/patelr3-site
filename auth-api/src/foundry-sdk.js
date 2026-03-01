// Foundry Agent SDK wrapper — uses @azure/ai-agents to interact with a
// Foundry-hosted agent that has OAuth identity passthrough for MCP tools.
// This replaces the manual SSE proxy in chat.js when FOUNDRY_MCP_CONNECTION_ID is set.
import {
  AgentsClient,
  RunStreamEvent,
  MessageStreamEvent,
  DoneEvent,
  ErrorEvent,
} from "@azure/ai-agents";
import { DefaultAzureCredential } from "@azure/identity";
import config from "./config.js";
import logger from "./logger.js";

let _client = null;

function getClient() {
  if (!_client) {
    const endpoint = config.foundryProjectEndpoint;
    if (!endpoint) throw new Error("FOUNDRY_PROJECT_ENDPOINT not configured");
    _client = new AgentsClient(endpoint, new DefaultAzureCredential());
  }
  return _client;
}

/**
 * Send a message to the Foundry agent and stream the response.
 *
 * @param {Object} opts
 * @param {string} opts.agentId        - Foundry agent ID
 * @param {Array}  opts.messages       - Conversation context [{role, content}]
 * @param {string} opts.instructions   - System instructions override
 * @param {Function} opts.onDelta      - Called with text chunks: (text) => void
 * @param {Function} opts.onEvent      - Called with raw events: (event) => void
 * @param {AbortSignal} [opts.signal]  - Abort signal for cancellation
 * @returns {{ assistantText: string, status: string }}
 */
export async function sendAgentMessage({
  agentId,
  messages,
  instructions,
  onDelta,
  onEvent,
  signal,
}) {
  const client = getClient();

  // 1. Create a temporary Foundry thread
  const thread = await client.threads.create();
  logger.info("Foundry SDK: created thread", { threadId: thread.id });

  // 2. Add conversation context as messages
  for (const msg of messages) {
    if (signal?.aborted) throw new Error("aborted");
    await client.messages.create(thread.id, msg.role, msg.content);
  }

  // 3. Create streaming run
  const runResponse = client.runs.create(thread.id, agentId, {
    instructions,
    stream: true,
  });
  const streamEvents = await runResponse.stream();

  let assistantText = "";
  let status = "unknown";
  let runId = null;

  // 4. Process stream events
  for await (const eventMessage of streamEvents) {
    if (signal?.aborted) {
      logger.warn("Foundry SDK: stream aborted by signal");
      break;
    }

    if (onEvent) onEvent(eventMessage);

    switch (eventMessage.event) {
      case MessageStreamEvent.ThreadMessageDelta: {
        const delta = eventMessage.data;
        if (delta?.delta?.content) {
          for (const part of delta.delta.content) {
            if (part.type === "text" && part.text?.value) {
              assistantText += part.text.value;
              if (onDelta) onDelta(part.text.value);
            }
          }
        }
        break;
      }

      case RunStreamEvent.ThreadRunCreated: {
        const run = eventMessage.data;
        runId = run?.id;
        logger.info("Foundry SDK: run created", { runId, status: run?.status });
        break;
      }

      case RunStreamEvent.ThreadRunCompleted: {
        status = "completed";
        logger.info("Foundry SDK: run completed", { runId });
        break;
      }

      case RunStreamEvent.ThreadRunFailed: {
        status = "failed";
        const run = eventMessage.data;
        logger.error("Foundry SDK: run failed", {
          runId,
          error: run?.lastError ? JSON.stringify(run.lastError).substring(0, 500) : "unknown",
        });
        break;
      }

      case RunStreamEvent.ThreadRunIncomplete: {
        status = "incomplete";
        logger.warn("Foundry SDK: run incomplete", { runId });
        break;
      }

      case RunStreamEvent.ThreadRunRequiresAction: {
        // This fires when the agent needs user action (e.g. OAuth consent)
        const run = eventMessage.data;
        logger.info("Foundry SDK: run requires action", {
          runId,
          actionType: run?.requiredAction?.type,
        });
        status = "requires_action";
        break;
      }

      case RunStreamEvent.ThreadRunExpired: {
        status = "expired";
        logger.warn("Foundry SDK: run expired", { runId });
        break;
      }

      case ErrorEvent.Error: {
        logger.error("Foundry SDK: stream error", {
          data: JSON.stringify(eventMessage.data).substring(0, 500),
        });
        status = "error";
        break;
      }

      case DoneEvent.Done:
        logger.info("Foundry SDK: stream done");
        break;

      default:
        // Log other events at debug level
        if (eventMessage.event && !eventMessage.event.includes("delta")) {
          logger.info("Foundry SDK: event", { event: eventMessage.event });
        }
        break;
    }
  }

  // 5. Cleanup: delete the temporary thread
  try {
    await client.threads.delete(thread.id);
  } catch (err) {
    logger.warn("Foundry SDK: failed to delete thread", { threadId: thread.id, error: err.message });
  }

  return { assistantText, status, runId };
}

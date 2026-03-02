// SunnieAI chat streaming proxy — Foundry new experience (Responses + Conversations API)
// Uses @azure/ai-projects SDK with agent_reference for the sunnieai agent.
// No database storage — conversations are ephemeral (Foundry-managed).
import { Router } from "express";
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import { trace, SpanStatusCode } from "./tracing.js";
import config from "./config.js";

const router = Router();
const tracer = trace.getTracer("chat");

// Lazy-init Foundry clients (only created once, on first use)
let projectClient = null;
let openaiClient = null;

function getClients() {
  if (!projectClient) {
    if (!config.foundryProjectEndpoint) {
      throw new Error("FOUNDRY_PROJECT_ENDPOINT is not configured");
    }
    projectClient = new AIProjectClient(
      config.foundryProjectEndpoint,
      new DefaultAzureCredential()
    );
    openaiClient = projectClient.getOpenAIClient({ maxRetries: 5 });
  }
  return { projectClient, openaiClient };
}

// ── Health check ───────────────────────────────────────────────
router.get("/chat/health", async (_req, res) => {
  try {
    getClients();
    res.json({ status: "ok", agent: config.foundryAgentName });
  } catch (err) {
    res.status(503).json({ status: "error", error: err.message });
  }
});

// ── Create conversation ────────────────────────────────────────
router.post("/chat/conversations", async (req, res) => {
  const span = tracer.startSpan("chat.createConversation", {
    attributes: {
      "user.id": String(req.dbUser.id),
      "user.email": req.dbUser.email,
    },
  });

  try {
    const { openaiClient } = getClients();
    const conversation = await openaiClient.conversations.create();

    span.setStatus({ code: SpanStatusCode.OK });
    res.status(201).json({ conversationId: conversation.id });
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    console.error("[chat] Failed to create conversation:", err.message);
    res.status(502).json({ error: "Failed to create conversation" });
  } finally {
    span.end();
  }
});

// ── Send message (SSE streaming) ───────────────────────────────
router.post("/chat/conversations/:id/messages", async (req, res) => {
  const conversationId = req.params.id;
  const { message, previousResponseId } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  await tracer.startActiveSpan("chat.sendMessage", {
    attributes: {
      "user.id": String(req.dbUser.id),
      "user.email": req.dbUser.email,
      "foundry.conversation_id": conversationId,
      "foundry.agent_name": config.foundryAgentName,
    },
  }, async (rootSpan) => {
    // Set up SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    try {
      const { openaiClient } = getClients();

      const requestBody = {
        input: !previousResponseId
          ? `[Current date: ${new Date().toISOString().slice(0, 10)}]\n\n${message}`
          : message,
        stream: true,
        store: true,
      };
      // Use conversation for the first message; subsequent messages chain via previous_response_id
      if (previousResponseId) {
        requestBody.previous_response_id = previousResponseId;
      } else {
        requestBody.conversation = conversationId;
      }

      // Use agent_reference — agent has model, instructions, and MCP tools configured server-side.
      // The @azure/ai-projects SDK merges options.body into the request body (see overwriteOpenAIClient.js).
      const response = await openaiClient.responses.create(
        { model: "gpt-4.1", ...requestBody },
        { body: { agent_reference: { name: config.foundryAgentName, type: "agent_reference" } } }
      );

      let responseId = null;
      // Track output item types to filter text deltas (only forward message text)
      const outputItemTypes = {};

      // Stream events to client
      for await (const event of response) {
        // Capture response ID for continuation / OAuth re-send
        if (event.response?.id) {
          responseId = event.response.id;
        }

        // Track new output items by type
        if (event.type === "response.output_item.added" && event.item?.id) {
          outputItemTypes[event.item.id] = event.item.type;
        }

        if (event.type === "response.output_item.done") {
          const item = event.item;
          if (item?.id) outputItemTypes[item.id] = item.type;

          // OAuth consent request — surface consent link to frontend
          if (item?.type === "oauth_consent_request") {
            rootSpan.addEvent("oauth_consent_requested");
            writeSseEvent(res, "oauth_consent", {
              consentLink: item.consent_link,
              responseId,
            });
            continue;
          }

          // Tool calls — notify frontend so it can show status
          if (item?.type === "function_call" || item?.type === "mcp_call") {
            rootSpan.addEvent("tool_call", { "tool.name": item.name || "unknown" });
            writeSseEvent(res, "tool_call", { name: item.name || item.tool_name || "tool" });
            continue;
          }

          // Assistant message
          if (item?.type === "message" && item.role === "assistant") {
            const text = item.content
              ?.filter((c) => c.type === "output_text")
              .map((c) => c.text)
              .join("");
            if (text) {
              writeSseEvent(res, "message", { text, responseId });
            }
          }
        }

        // Streaming text delta — only forward for message items (not tool calls)
        if (event.type === "response.output_text.delta") {
          const itemType = outputItemTypes[event.item_id];
          if (!itemType || itemType === "message") {
            writeSseEvent(res, "text_delta", { delta: event.delta });
          }
        }

        // Response completed
        if (event.type === "response.completed") {
          const resp = event.response;

          // Handle incomplete — auto-continue if max output tokens
          if (resp?.status === "incomplete" && resp?.incomplete_details?.reason === "max_output_tokens") {
            rootSpan.addEvent("auto_continue", { "response.id": resp.id });
            writeSseEvent(res, "status", { status: "continuing" });
          }

          writeSseEvent(res, "done", {
            responseId: resp?.id,
            status: resp?.status || "completed",
            conversationId,
          });
        }
      }

      rootSpan.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      console.error("[chat] Stream error:", err.message);
      const isRateLimit = err.status === 429 || err.code === "rate_limit_exceeded";
      writeSseEvent(res, "error", {
        error: isRateLimit
          ? "SunnieAI is a bit busy right now — please try again in a moment."
          : err.message,
        correlationId: rootSpan.spanContext().traceId,
      });
    } finally {
      rootSpan.end();
      res.end();
    }
  });
});

// ── Helpers ────────────────────────────────────────────────────

function writeSseEvent(res, eventType, data) {
  try {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
    res.flush?.();
  } catch {
    // Client disconnected
  }
}

export default router;

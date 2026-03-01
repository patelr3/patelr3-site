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
    openaiClient = projectClient.getOpenAIClient();
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
        input: message,
        conversation: conversationId,
        stream: true,
        store: true,
        ...(previousResponseId && { previous_response_id: previousResponseId }),
      };

      // Use agent_reference — agent has model, instructions, and MCP tools configured server-side
      // model is required by the API even with agent_reference (agent overrides it)
      const response = await openaiClient.responses.create({
        model: "gpt-4.1",
        ...requestBody,
        extra_body: {
          agent_reference: { name: config.foundryAgentName, type: "agent_reference" },
        },
      });

      let responseId = null;

      // Stream events to client
      for await (const event of response) {
        // Capture response ID for continuation / OAuth re-send
        if (event.response?.id) {
          responseId = event.response.id;
        }

        if (event.type === "response.output_item.done") {
          const item = event.item;

          // OAuth consent request — surface consent link to frontend
          if (item?.type === "oauth_consent_request") {
            rootSpan.addEvent("oauth_consent_requested");
            writeSseEvent(res, "oauth_consent", {
              consentLink: item.consent_link,
              responseId,
            });
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

        // Streaming text delta
        if (event.type === "response.output_text.delta") {
          writeSseEvent(res, "text_delta", { delta: event.delta });
        }

        // Response completed
        if (event.type === "response.completed") {
          const resp = event.response;

          // Handle incomplete — auto-continue if max output tokens
          if (resp?.status === "incomplete" && resp?.incomplete_details?.reason === "max_output_tokens") {
            rootSpan.addEvent("auto_continue", { "response.id": resp.id });
            writeSseEvent(res, "status", { status: "continuing" });
            // Continue by re-calling with previous_response_id
            // (Frontend should re-send with previousResponseId if needed)
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
      writeSseEvent(res, "error", {
        error: err.message,
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

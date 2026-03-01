// SunnieAI chat proxy — forwards chat requests to Azure AI Foundry Agent Service.
// Uses the @azure/ai-projects SDK with the Conversations API for per-user OAuth
// isolation (fixes cross-user token leakage). Agent has model, instructions, and
// MCP tools with OAuth identity passthrough configured server-side.
// Manages conversation history locally with rolling summarization.
import { Router } from "express";
import { trace, context, SpanStatusCode } from "./tracing.js";
import logger from "./logger.js";
import config from "./config.js";
import {
  createThread, getUserThreads, deleteThread,
  addChatMessage, getChatMessages, getChatMessageCount,
  updateThreadSummary, getThreadSummary,
  getWrappedVaultKey, getThreadById,
  getThreadFoundryConversationId, updateThreadFoundryConversationId,
} from "./db.js";
import { deriveServerKey, unwrapKey } from "./crypto.js";
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";

const router = Router();
const tracer = trace.getTracer("chat");

// Azure AI Foundry config
const FOUNDRY_ENDPOINT = config.foundryProjectEndpoint;
const FOUNDRY_AGENT_NAME = config.foundryAgentName;

// SDK client — lazily initialized (null when endpoint not configured)
let _projectClient = null;
let _openaiClient = null;
function getOpenAIClient() {
  if (_openaiClient) return _openaiClient;
  if (!FOUNDRY_ENDPOINT) return null;
  const credential = new DefaultAzureCredential();
  _projectClient = new AIProjectClient(FOUNDRY_ENDPOINT, credential);
  _openaiClient = _projectClient.getOpenAIClient();
  return _openaiClient;
}

// Summarization thresholds
const SUMMARY_THRESHOLD = 10;  // summarize when > 10 messages
const RECENT_MESSAGES_KEEP = 6; // keep last 6 messages verbatim

/** Unwrap the user's vault key for chat encryption. Returns Buffer or null. */
async function getUserVaultKey(userId) {
  if (!config.chatEncryptionKey) return null;
  try {
    const vkRow = await getWrappedVaultKey(userId);
    if (!vkRow) return null;
    const wrappingKey = deriveServerKey(userId);
    return unwrapKey(vkRow.wrapped_key, Buffer.from(wrappingKey));
  } catch {
    return null;
  }
}

// ── Health check ───────────────────────────────────────────────
router.get("/health", async (_req, res) => {
  const health = {
    configured: !!(FOUNDRY_ENDPOINT && FOUNDRY_AGENT_NAME),
    endpoint: FOUNDRY_ENDPOINT ? "set" : "missing",
    agentName: FOUNDRY_AGENT_NAME || "missing",
    api: "responses",
  };

  // Quick connectivity test (non-blocking)
  try {
    const client = getOpenAIClient();
    if (!client) {
      health.foundryError = "SDK client not configured";
    } else {
      const testRes = await client.responses.create({
        input: "test",
        model: "gpt-4.1",
        store: false,
        max_output_tokens: 16,
      });
      health.foundryStatus = testRes?.id ? "ok" : "unknown";
    }
  } catch (err) {
    health.foundryError = err.message;
  }

  res.json(health);
});

// ── List user's chat threads ───────────────────────────────────
router.get("/threads", async (req, res) => {
  try {
    const threads = await getUserThreads(Number(req.jwtUser.sub));
    res.json(threads);
  } catch (err) {
    logger.error("Failed to list threads", { error: err.message });
    res.status(500).json({ error: "Failed to list threads" });
  }
});

// ── Create a new thread ────────────────────────────────────────
router.post("/threads", async (req, res) => {
  try {
    const { title } = req.body;
    const thread = await createThread(
      Number(req.jwtUser.sub),
      title || "New conversation",
    );

    // Create a Foundry conversation for per-user OAuth isolation
    try {
      const client = getOpenAIClient();
      if (client) {
        const conversation = await client.conversations.create();
        if (conversation?.id) {
          await updateThreadFoundryConversationId(thread.id, conversation.id);
          thread.foundry_conversation_id = conversation.id;
        }
      }
    } catch (err) {
      // Non-fatal: thread still works without conversation scoping
      logger.warn("Failed to create Foundry conversation", { error: err.message });
    }

    res.status(201).json(thread);
  } catch (err) {
    logger.error("Thread creation error", { error: err.message });
    res.status(500).json({ error: "Failed to create thread" });
  }
});

// ── Delete a thread ────────────────────────────────────────────
router.delete("/threads/:threadId", async (req, res) => {
  try {
    const deleted = await deleteThread(
      Number(req.jwtUser.sub),
      req.params.threadId,
    );
    if (!deleted) return res.status(404).json({ error: "Thread not found" });
    res.json({ success: true });
  } catch (err) {
    logger.error("Thread deletion error", { error: err.message });
    res.status(500).json({ error: "Failed to delete thread" });
  }
});

// ── Get messages for a thread ──────────────────────────────────
router.get("/threads/:threadId/messages", async (req, res) => {
  try {
    const userId = Number(req.jwtUser.sub);
    const threadId = Number(req.params.threadId);
    // Ownership check: ensure the thread belongs to the requesting user
    const thread = await getThreadById(threadId);
    if (!thread || thread.user_id !== userId) {
      return res.status(404).json({ error: "Thread not found" });
    }
    const vaultKey = await getUserVaultKey(userId);
    const messages = await getChatMessages(threadId, vaultKey);
    // Return in the same format the frontend expects
    const data = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));
    res.json({ data });
  } catch (err) {
    logger.error("Get messages error", { error: err.message });
    res.status(500).json({ error: "Failed to get messages" });
  }
});

// Build the input array for the Responses API with summarization
async function buildInput(threadId, newUserContent, vaultKey = null) {
  const messages = await getChatMessages(threadId, vaultKey);
  const summary = await getThreadSummary(threadId, vaultKey);
  const input = [];

  if (summary && messages.length > RECENT_MESSAGES_KEEP) {
    // Prepend summary of older context
    input.push({
      role: "user",
      content: `[Context from earlier in this conversation: ${summary}]`,
    });
    // Only include recent messages
    const recent = messages.slice(-RECENT_MESSAGES_KEEP);
    for (const m of recent) {
      input.push({ role: m.role, content: m.content });
    }
  } else {
    // Send all messages
    for (const m of messages) {
      input.push({ role: m.role, content: m.content });
    }
  }

  // Add the new user message
  input.push({ role: "user", content: newUserContent });
  return input;
}

// Generate a summary of older messages (background, non-blocking)
async function maybeSummarize(threadId, vaultKey = null) {
  try {
    const count = await getChatMessageCount(threadId);
    if (count <= SUMMARY_THRESHOLD) return;

    const messages = await getChatMessages(threadId, vaultKey);
    // Summarize all but the last RECENT_MESSAGES_KEEP messages
    const toSummarize = messages.slice(0, -RECENT_MESSAGES_KEEP);
    if (toSummarize.length < 4) return; // not enough to summarize

    const summaryPrompt = toSummarize
      .map(m => `${m.role}: ${m.content}`)
      .join("\n");

    const client = getOpenAIClient();
    if (!client) return;

    const summaryRes = await client.responses.create({
      input: [
        {
          role: "user",
          content: `Summarize this conversation in 2-3 concise sentences, preserving key facts and decisions:\n\n${summaryPrompt}`,
        },
      ],
      model: "gpt-4.1",
      store: false,
      max_output_tokens: 200,
    });

    const summaryText =
      summaryRes?.output?.[0]?.content?.[0]?.text ||
      summaryRes?.output_text ||
      "";
    if (summaryText) {
      await updateThreadSummary(threadId, summaryText, vaultKey);
    }
  } catch (err) {
    logger.error("Summarization failed (non-critical)", { error: err.message });
  }
}

// ── Send message and run agent (streaming) ─────────────────────

/** Write an error message to the SSE stream with correlation ID. */
function writeStreamError(res, correlationId, errMsg) {
  try {
    res.write(`data: ${JSON.stringify({ type: "error.correlation", correlationId })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: errMsg })}\n\n`);
  } catch { /* client gone */ }
}

/**
 * Stream a single Foundry response via the SDK, forwarding events as SSE to the client.
 * Returns { responseId, status, output, error, assistantChunk, oauthConsentUrl }.
 */
async function streamSDKResponse(client, params, sdkOpts, res, label = "main") {
  return tracer.startActiveSpan("chat.streamResponse", { attributes: { label } }, async (streamSpan) => {
    let responseId = null;
    let status = null;
    let output = [];
    let lastError = null;
    let textChunk = "";
    let oauthConsentSent = false;

    const STREAM_EVENT_TIMEOUT_MS = 300_000;
    let eventTimer = null;
    const resetTimer = () => {
      if (eventTimer) clearTimeout(eventTimer);
      eventTimer = setTimeout(() => {
        logger.error("Stream event timeout", { label });
        streamSpan.setStatus({ code: SpanStatusCode.ERROR, message: "stream_timeout" });
        // Abort will cause the for-await to throw
        if (sdkOpts.signal && !sdkOpts.signal.aborted) {
          sdkOpts._abortController?.abort();
        }
      }, STREAM_EVENT_TIMEOUT_MS);
    };

    try {
      const stream = await client.responses.create(params, sdkOpts);

      for await (const event of stream) {
        resetTimer();

        // Re-serialize for frontend SSE proxy (preserves the existing contract)
        res.write(`data: ${JSON.stringify(event)}\n\n`);

        // Collect text deltas
        if (event.type === "response.output_text.delta" && event.delta) {
          textChunk += event.delta;
        }

        // Track completion
        if (event.type === "response.completed" && event.response) {
          responseId = event.response.id;
          status = event.response.status;
          output = event.response.output || [];
          logger.info("Response completed", {
            label, responseId, status, outputCount: output.length,
          });
          for (const item of output) {
            logger.info("Response output", {
              label, type: item.type,
              ...(item.type === "mcp_call" ? { mcpCallName: item.name } : {}),
            });
          }
        }

        // Track incomplete responses (max_output_tokens reached)
        if (event.type === "response.incomplete" && event.response) {
          responseId = event.response.id;
          status = "incomplete";
          output = event.response.output || [];
        }

        // Track failures
        if (event.type === "response.failed" && event.response) {
          responseId = event.response.id;
          status = "failed";
          output = event.response.output || [];
          const errDetail = event.response.error || event.response.last_error || lastError;
          logger.error("Response FAILED", {
            label, responseId,
            error: JSON.stringify(errDetail).substring(0, 500),
            outputCount: output.length,
          });
          streamSpan.setStatus({ code: SpanStatusCode.ERROR, message: "response.failed" });
        }

        // Detect OAuth consent request from Foundry (send at most once)
        if (event.type === "response.oauth_consent_requested" && !oauthConsentSent) {
          const consentUrl = event.consent_link || event.authorization_url || event.url
            || event.item?.consent_link || event.item?.authorization_url || event.item?.url || "";
          if (consentUrl) {
            logger.info("OAuth consent requested", { label, url: consentUrl });
            res.write(`data: ${JSON.stringify({ type: "oauth_consent", url: consentUrl })}\n\n`);
            oauthConsentSent = true;
          } else {
            logger.warn("OAuth consent event with no URL", { label, eventKeys: Object.keys(event).join(",") });
          }
        }

        // Also detect oauth_consent_request in output_item.added events
        if (event.type === "response.output_item.added" && event.item?.type === "oauth_consent_request" && !oauthConsentSent) {
          const consentUrl = event.item.consent_link || event.item.authorization_url || event.item.url || "";
          if (consentUrl) {
            logger.info("OAuth consent from output item", { label, url: consentUrl });
            res.write(`data: ${JSON.stringify({ type: "oauth_consent", url: consentUrl })}\n\n`);
            oauthConsentSent = true;
          }
        }

        // Log MCP call details
        if (event.type === "response.mcp_call.in_progress" && event.item) {
          logger.info("MCP call starting", {
            label,
            mcpCallName: event.item.name || "?",
            serverLabel: event.item.server_label || "?",
          });
        }
        if (event.type === "response.mcp_call.completed" && event.item) {
          const mcpOut = event.item.output || "";
          const truncated = typeof mcpOut === "string" ? mcpOut.substring(0, 500) : JSON.stringify(mcpOut).substring(0, 500);
          logger.info("MCP call completed", { label, mcpCallName: event.item.name || "?", mcpOutput: truncated });
        }
        if (event.type === "response.output_item.done" && event.item?.type === "mcp_call") {
          const mcpOut = event.item.output || "";
          const truncated = typeof mcpOut === "string" ? mcpOut.substring(0, 500) : JSON.stringify(mcpOut).substring(0, 500);
          logger.info("MCP call result", { label, mcpCallName: event.item.name || "?", mcpOutput: truncated });
        }

        // Log non-delta events
        if (event.type && !event.type.includes("delta")) {
          logger.info("SSE event", { label, eventType: event.type });
        }
      }
    } catch (err) {
      // SDK throws APIError on HTTP failures and error SSE events
      if (!status) {
        lastError = err;
        logger.error("SDK stream error", { label, error: err.message?.substring(0, 500) });
        streamSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      }
    } finally {
      if (eventTimer) clearTimeout(eventTimer);
    }

    // Check output items for oauth_consent_request (may arrive without the SSE event)
    if (!oauthConsentSent) {
      for (const item of output) {
        if (item.type === "oauth_consent_request") {
          const consentUrl = item.consent_link || item.authorization_url || item.url || "";
          if (consentUrl) {
            logger.info("OAuth consent found in output", { label, url: consentUrl });
            res.write(`data: ${JSON.stringify({ type: "oauth_consent", url: consentUrl })}\n\n`);
            oauthConsentSent = true;
            break;
          }
        }
      }
    }

    const oauthConsentUrl = oauthConsentSent ? "sent" : null;
    streamSpan.setAttributes({
      responseId: responseId || "",
      status: status || "unknown",
      outputCount: output.length,
      textLength: textChunk.length,
    });
    streamSpan.end();
    return { responseId, status, output, error: lastError, assistantChunk: textChunk, oauthConsentUrl };
  });
}

router.post("/threads/:threadId/messages", async (req, res) => {
  await tracer.startActiveSpan("chat.sendMessage", async (rootSpan) => {
  try {
    const correlationId = rootSpan.spanContext().traceId;
    res.setHeader("X-Trace-ID", correlationId);

  const threadId = Number(req.params.threadId);
  const userId = Number(req.jwtUser.sub);

  // Add user attributes for App Insights filtering
  rootSpan.setAttributes({
    "enduser.id": String(userId),
    "enduser.name": req.jwtUser.name || "",
  });

  // Ownership check: ensure the thread belongs to the requesting user (before any other processing)
  try {
    const thread = await getThreadById(threadId);
    if (!thread || thread.user_id !== userId) {
      return res.status(404).json({ error: "Thread not found" });
    }
  } catch (err) {
    logger.error("Thread ownership check failed", { error: err.message });
    return res.status(500).json({ error: "Failed to validate thread", correlationId });
  }

  if (!FOUNDRY_ENDPOINT || !FOUNDRY_AGENT_NAME) {
    return res.status(503).json({ error: "AI service not configured", correlationId });
  }

  const { content } = req.body;
  if (!content) {
    return res.status(400).json({ error: "content is required", correlationId });
  }

  try {
    // 0. Unwrap user's vault key (null if encryption not configured)
    const vaultKey = await getUserVaultKey(userId);

    // 1. Build input with summarization (BEFORE storing the new message)
    const input = await buildInput(threadId, content, vaultKey);

    // 2. Store user message in DB
    await addChatMessage(threadId, "user", content, vaultKey);

    // 3. Get SDK client and Foundry conversation ID for per-user OAuth isolation
    const client = getOpenAIClient();
    const foundryConversationId = await getThreadFoundryConversationId(threadId);

    function buildCreateParams(inputData, extraOpts = {}) {
      const params = {
        input: inputData,
        stream: true,
        store: false,
        max_output_tokens: 16384,
        ...extraOpts,
      };
      // Scope to Foundry conversation for per-user OAuth isolation
      if (foundryConversationId && !extraOpts.previous_response_id) {
        params.conversation = foundryConversationId;
      }
      return params;
    }

    // SDK options: agent_reference is passed via body merge (Azure SDK wraps responses.create)
    const abortController = new AbortController();
    const overallTimeout = setTimeout(() => abortController.abort(), 360_000);
    const sdkOpts = {
      body: {
        agent_reference: { name: FOUNDRY_AGENT_NAME, type: "agent_reference" },
      },
      signal: abortController.signal,
      _abortController: abortController,
    };

    // 4. Stream SSE response to client
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    let assistantText = "";

    // Send SSE heartbeat every 15s to keep proxies from closing the connection
    const heartbeat = setInterval(() => {
      try { res.write(":heartbeat\n\n"); } catch { /* client gone */ }
    }, 15_000);

    try {
      await tracer.startActiveSpan("chat.runAgent", { attributes: { threadId } }, async (agentSpan) => {
      const MAX_ATTEMPTS = 3;
      let attempt = 0;

      logger.info("Chat request", { threadId, conversationId: foundryConversationId || "none" });

      for (attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const label = attempt === 0 ? "main" : `retry#${attempt}`;
        const params = buildCreateParams(input);

        const result = await streamSDKResponse(client, params, sdkOpts, res, label);
        assistantText += result.assistantChunk;

        // OAuth consent requested — not a failure, user needs to authorize
        if (result.oauthConsentUrl) {
          logger.info("OAuth consent flow — stopping retries", { attempt: attempt + 1 });
          break;
        }

        if (result.status === "failed") {
          logger.error("Response failed on attempt", {
            attempt: attempt + 1, error: JSON.stringify(result.error).substring(0, 300),
          });
          if (attempt < MAX_ATTEMPTS - 1) {
            logger.info("Retrying after failure", { attempt: attempt + 2, maxAttempts: MAX_ATTEMPTS });
            await new Promise(r => setTimeout(r, 2000));
            res.write(`data: ${JSON.stringify({ type: "response.in_progress" })}\n\n`);
            continue;
          }
          const errMsg = "\n\n⚠️ I had trouble completing that request. Could you try rephrasing or breaking it into smaller questions?";
          assistantText += errMsg;
          writeStreamError(res, correlationId, errMsg);
          agentSpan.setStatus({ code: SpanStatusCode.ERROR, message: "max_retries_exceeded" });
          rootSpan.recordException(new Error("Foundry response failed after max retries"));
          break;
        }

        // Handle stream timeout or abnormal termination (no completion event)
        if (!result.status) {
          logger.error("Stream ended without completion event", { attempt: attempt + 1, label });
          if (attempt < MAX_ATTEMPTS - 1) {
            await new Promise(r => setTimeout(r, 2000));
            res.write(`data: ${JSON.stringify({ type: "response.in_progress" })}\n\n`);
            continue;
          }
          const errMsg = "\n\n⚠️ The request timed out. Please try again.";
          assistantText += errMsg;
          writeStreamError(res, correlationId, errMsg);
          agentSpan.setStatus({ code: SpanStatusCode.ERROR, message: "stream_timeout" });
          rootSpan.recordException(new Error("Stream ended without completion event (timeout)"));
          break;
        }

        // Handle continuation (incomplete or tool-only output)
        let responseId = result.responseId;
        let lastStatus = result.status;
        let lastOutput = result.output;
        let continuationRound = 0;
        const MAX_CONTINUATIONS = 5;

        while (responseId && continuationRound < MAX_CONTINUATIONS) {
          const hasToolOutput = lastOutput.some(o => o.type === "mcp_call");
          const hasTextOutput = lastOutput.some(o => o.type === "message" || o.type === "text");
          const needsContinuation =
            lastStatus === "incomplete" ||
            (hasToolOutput && !hasTextOutput);
          if (!needsContinuation) break;

          continuationRound++;
          logger.info("Continuation round", {
            round: continuationRound, status: lastStatus, outputCount: lastOutput.length,
          });

          // Use previous_response_id for continuations (mutually exclusive with conversation)
          const contParams = buildCreateParams([], { previous_response_id: responseId });
          const contResult = await streamSDKResponse(client, contParams, sdkOpts, res, `cont#${continuationRound}`);
          assistantText += contResult.assistantChunk;
          responseId = contResult.responseId;
          lastStatus = contResult.status;
          lastOutput = contResult.output;

          if (!contResult.status) {
            logger.error("Continuation stream timeout", { round: continuationRound });
            rootSpan.recordException(new Error(`Continuation stream timeout: round ${continuationRound}`));
            const errMsg = "\n\n⚠️ The request timed out while completing the analysis. Please try again.";
            assistantText += errMsg;
            writeStreamError(res, correlationId, errMsg);
            break;
          }
          if (contResult.status === "failed") {
            logger.error("Continuation response failed", { round: continuationRound });
            rootSpan.recordException(new Error(`Continuation response failed: round ${continuationRound}`));
            const errMsg = "\n\n⚠️ I had trouble completing that request. Could you try rephrasing or breaking it into smaller questions?";
            assistantText += errMsg;
            writeStreamError(res, correlationId, errMsg);
            break;
          }
        }

        if (continuationRound >= MAX_CONTINUATIONS) {
          logger.warn("Max continuations reached", { round: continuationRound, max: MAX_CONTINUATIONS });
          rootSpan.recordException(new Error(`Max continuations reached: ${continuationRound}/${MAX_CONTINUATIONS}`));
          const errMsg = "\n\n⚠️ This request required too many steps. Please try breaking it into smaller questions.";
          assistantText += errMsg;
          writeStreamError(res, correlationId, errMsg);
        }

        agentSpan.setAttributes({ attempt: attempt + 1, continuations: continuationRound });
        // If we reached here without failure, we're done
        if (result.status !== "failed") break;
      }
      agentSpan.end();
      });
    } catch (streamErr) {
      logger.error("Stream error", { error: streamErr.message });
      rootSpan.recordException(streamErr);
      const errMsg = "\n\n⚠️ I encountered an unexpected error. Please try again.";
      assistantText += errMsg;
      writeStreamError(res, correlationId, errMsg);
    } finally {
      clearTimeout(overallTimeout);
      clearInterval(heartbeat);
      res.end();
    }

    // 5. Store assistant response in DB (async, non-blocking)
    if (assistantText) {
      addChatMessage(threadId, "assistant", assistantText, vaultKey).catch(err =>
        logger.error("Failed to store assistant message", { error: err.message }),
      );
      // Trigger summarization in background
      maybeSummarize(threadId, vaultKey).catch(() => {});
    }
  } catch (err) {
    logger.error("Message/run error", { error: err.message });
    rootSpan.recordException(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to process message", correlationId });
    }
  }
  } finally {
    rootSpan.end();
  }
  });
});

export default router;

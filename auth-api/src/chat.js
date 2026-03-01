// SunnieAI chat proxy — forwards chat requests to Azure AI Foundry Agent Service.
// Supports two modes:
//   1. Agent mode (FOUNDRY_MCP_CONNECTION_ID set) — uses Foundry Responses API
//      with agent_reference (agent has MCP tools with OAuth identity passthrough).
//   2. Inline tools mode (fallback) — sends per-request MCP tool config with
//      user JWT in headers (legacy, for when no agent connection is configured).
// Manages conversation history locally with rolling summarization.
import { Router } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { trace, context, SpanStatusCode } from "./tracing.js";
import logger from "./logger.js";
import config from "./config.js";
import {
  createThread, getUserThreads, deleteThread,
  addChatMessage, getChatMessages, getChatMessageCount,
  updateThreadSummary, getThreadSummary,
  getWrappedVaultKey,
} from "./db.js";
import { deriveServerKey, unwrapKey } from "./crypto.js";

const router = Router();
const tracer = trace.getTracer("chat");

// Azure AI Foundry config
const FOUNDRY_ENDPOINT = config.foundryProjectEndpoint;
const FOUNDRY_AGENT_NAME = config.foundryAgentName;
const MCP_SERVER_URL = config.mcpServerUrl;

// Agent instructions: short role prompt + domain knowledge from markdown file
const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_KNOWLEDGE = readFileSync(join(__dirname, "agent-knowledge.md"), "utf-8");
const AGENT_INSTRUCTIONS_BASE =
  "You are SunnieAI, a personal finance assistant. " +
  "You have access to the user's Actual Budget data through MCP tools. " +
  "Use the available tools to help manage budgets, accounts, transactions, " +
  "categories, and more. Be friendly, concise, and helpful. " +
  "Confirm destructive actions before executing.\n\n" +
  "IMPORTANT: Always call MCP tools to fetch real data before answering financial questions. " +
  "Never respond with placeholder text like 'let me look into that' — complete the full " +
  "analysis in your response. When analyzing trends or comparisons, retrieve all necessary " +
  "data, compute the results, and present them with specific numbers and formatting.\n\n" +
  AGENT_KNOWLEDGE;

// Build instructions with current date injected so the model knows "today"
function getAgentInstructions() {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "America/New_York",
  });
  return `Current date: ${dateStr}\n\n${AGENT_INSTRUCTIONS_BASE}`;
}

// Foundry v1 endpoint: {project-endpoint}/openai/v1 (version embedded in path)
function getOpenAIBaseUrl() {
  if (!FOUNDRY_ENDPOINT) return "";
  return `${FOUNDRY_ENDPOINT.replace(/\/+$/, "")}/openai/v1`;
}
const OPENAI_BASE = getOpenAIBaseUrl();

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

async function getAzureToken() {
  return tracer.startActiveSpan("chat.getAzureToken", async (span) => {
    try {
      const { DefaultAzureCredential } = await import("@azure/identity");
      const credential = new DefaultAzureCredential();
      const token = await credential.getToken("https://ai.azure.com/.default");
      span.end();
      return token.token;
    } catch (err) {
      logger.error("Failed to get Azure token", { error: err.message });
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.end();
      throw err;
    }
  });
}

async function foundryFetch(path, opts = {}) {
  return tracer.startActiveSpan("chat.foundryFetch", { attributes: { "http.method": opts.method || "GET", "http.url": path } }, async (span) => {
    const token = await getAzureToken();
    const url = `${OPENAI_BASE}${path}`;
    logger.info("Foundry request", { method: opts.method || "GET", url });
    const res = await fetch(url, {
      ...opts,
      signal: opts.signal || AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...opts.headers,
      },
    });
    logger.info("Foundry response", { status: res.status, statusText: res.statusText, url });
    span.setAttribute("http.status_code", res.status);
    span.end();
    return res;
  });
}

// ── Health check ───────────────────────────────────────────────
router.get("/health", async (_req, res) => {
  const health = {
    configured: !!(FOUNDRY_ENDPOINT && FOUNDRY_AGENT_NAME),
    endpoint: FOUNDRY_ENDPOINT ? "set" : "missing",
    agentName: FOUNDRY_AGENT_NAME || "missing",
    api: "responses",
    openaiBase: OPENAI_BASE || "not-set",
  };

  // Quick connectivity test (non-blocking)
  try {
    const testRes = await foundryFetch("/responses", {
      method: "POST",
      body: JSON.stringify({
        input: "test",
        model: "gpt-5.2-chat",
        store: false,
        max_output_tokens: 16,
      }),
    });
    health.foundryStatus = testRes.status;
    if (!testRes.ok) {
      const err = await testRes.text();
      health.foundryError = err.substring(0, 300);
    } else {
      health.foundryStatus = "ok";
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
    const vaultKey = await getUserVaultKey(Number(req.jwtUser.sub));
    const messages = await getChatMessages(Number(req.params.threadId), vaultKey);
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

    const summaryRes = await foundryFetch(
      "/responses",
      {
        method: "POST",
        body: JSON.stringify({
          input: [
            {
              role: "user",
              content: `Summarize this conversation in 2-3 concise sentences, preserving key facts and decisions:\n\n${summaryPrompt}`,
            },
          ],
          model: "gpt-5.2-chat",
          store: false,
          max_output_tokens: 200,
        }),
      },
    );

    if (summaryRes.ok) {
      const data = await summaryRes.json();
      const summaryText =
        data?.output?.[0]?.content?.[0]?.text ||
        data?.output_text ||
        "";
      if (summaryText) {
        await updateThreadSummary(threadId, summaryText, vaultKey);
      }
    }
  } catch (err) {
    logger.error("Summarization failed (non-critical)", { error: err.message });
  }
}

// ── Send message and run agent (streaming) ─────────────────────
router.post("/threads/:threadId/messages", async (req, res) => {
  // Extract OTel traceId for error correlation
  const span = trace.getSpan(context.active());
  const correlationId = span?.spanContext()?.traceId || randomUUID();
  res.setHeader("X-Trace-ID", correlationId);

  if (!FOUNDRY_ENDPOINT || !FOUNDRY_AGENT_NAME) {
    return res.status(503).json({ error: "AI service not configured", correlationId });
  }

  const { content } = req.body;
  if (!content) {
    return res.status(400).json({ error: "content is required", correlationId });
  }

  const threadId = Number(req.params.threadId);
  const userId = Number(req.jwtUser.sub);

  try {
    // 0. Unwrap user's vault key (null if encryption not configured)
    const vaultKey = await getUserVaultKey(userId);

    // 1. Build input with summarization (BEFORE storing the new message)
    const input = await buildInput(threadId, content, vaultKey);

    // 2. Store user message in DB
    await addChatMessage(threadId, "user", content, vaultKey);

    // 3. Create response (streaming) via Responses API
    const userJwt = req.cookies.access_token;

    // When FOUNDRY_MCP_CONNECTION_ID is set, the Foundry agent has MCP tools
    // configured server-side with OAuth identity passthrough — no inline tools needed.
    // Otherwise, fall back to per-request inline MCP tools with user JWT.
    const useAgentReference = !!(config.foundryMcpConnectionId && FOUNDRY_AGENT_NAME);
    const mcpTools = [];
    if (!useAgentReference && MCP_SERVER_URL && userJwt) {
      mcpTools.push({
        type: "mcp",
        server_label: "actual-budget-mcp",
        server_url: `${MCP_SERVER_URL.replace(/\/+$/, "")}/mcp`,
        headers: { Authorization: `Bearer ${userJwt}` },
        require_approval: "never",
      });
    }

    function buildResponseBody(inputData, extraOpts = {}) {
      const body = {
        input: inputData,
        stream: true,
        store: false,
        max_output_tokens: 16384,
        ...extraOpts,
      };
      if (useAgentReference) {
        // New Foundry experience: agent has model, instructions, and MCP tools
        body.agent_reference = {
          name: FOUNDRY_AGENT_NAME,
          type: "agent_reference",
        };
      } else {
        // Inline mode: specify model + instructions + tools directly
        body.model = "gpt-5.2-chat";
        body.instructions = getAgentInstructions();
        if (mcpTools.length > 0) {
          body.tools = mcpTools;
        }
      }
      return body;
    }

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

    // Helper: stream one Foundry response, forwarding SSE to client.
    // Returns { responseId, status, output, error, assistantChunk }.
    const STREAM_TIMEOUT_MS = 300_000;
    async function streamFoundryResponse(foundryRes, label = "main") {
      return tracer.startActiveSpan("chat.streamResponse", { attributes: { label } }, async (streamSpan) => {
      const reader = foundryRes.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      let responseId = null;
      let status = null;
      let output = [];
      let lastError = null;
      let textChunk = "";

      while (true) {
        let result;
        try {
          result = await Promise.race([
            reader.read(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("stream_timeout")), STREAM_TIMEOUT_MS),
            ),
          ]);
        } catch {
          logger.error("Stream timeout", { label });
          streamSpan.setStatus({ code: SpanStatusCode.ERROR, message: "stream_timeout" });
          reader.cancel();
          break;
        }
        const { done, value } = result;
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });

        sseBuffer += chunk;
        const sseLines = sseBuffer.split("\n");
        sseBuffer = sseLines.pop() || "";

        for (const line of sseLines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const event = JSON.parse(data);
            // Collect text
            if (event.type === "response.output_text.delta" && event.delta) {
              textChunk += event.delta;
            }
            const classicDelta = event?.delta?.content?.[0]?.text?.value;
            if (classicDelta) textChunk += classicDelta;

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

            // Track failures
            if (event.type === "error") {
              lastError = event.error || event;
              logger.error("SSE error event", {
                label, error: JSON.stringify(lastError).substring(0, 500),
              });
            }
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

            // Log MCP call details
            if (event.type === "response.mcp_call.in_progress" && event.item) {
              logger.info("MCP call starting", {
                label,
                mcpCallName: event.item.name || "?",
                serverLabel: event.item.server_label || "?",
              });
            }

            // Log non-delta events
            if (event.type && !event.type.includes("delta")) {
              logger.info("SSE event", { label, eventType: event.type });
            }
          } catch {
            // skip unparseable
          }
        }

        res.write(chunk);
      }

      streamSpan.setAttributes({
        responseId: responseId || "",
        status: status || "unknown",
        outputCount: output.length,
        textLength: textChunk.length,
      });
      streamSpan.end();
      return { responseId, status, output, error: lastError, assistantChunk: textChunk };
      });
    }

    try {
      await tracer.startActiveSpan("chat.runAgent", { attributes: { threadId, model: "gpt-5.2-chat" } }, async (agentSpan) => {
      const MAX_ATTEMPTS = 3;
      let currentInput = input;
      let attempt = 0;

      for (attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const label = attempt === 0 ? "main" : `retry#${attempt}`;
        const body = buildResponseBody(currentInput);

        const runRes = await foundryFetch("/responses", {
          method: "POST",
          headers: { Accept: "text/event-stream" },
          body: JSON.stringify(body),
        });

        if (!runRes.ok) {
          const err = await runRes.text();
          logger.error("Response creation failed", { label, status: runRes.status, error: err.substring(0, 500) });
          if (attempt < MAX_ATTEMPTS - 1 && runRes.status === 429) {
            logger.info("Rate limited, waiting 5s before retry", { attempt });
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }
          if (!res.headersSent || res.getHeader("Content-Type") === "text/event-stream") {
            const errMsg = "\n\n⚠️ I encountered an error. Please try again.";
            assistantText += errMsg;
            res.write(`data: ${JSON.stringify({ type: "error.correlation", correlationId })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: errMsg })}\n\n`);
          }
          agentSpan.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${runRes.status}` });
          break;
        }

        const result = await streamFoundryResponse(runRes, label);
        assistantText += result.assistantChunk;

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
          res.write(`data: ${JSON.stringify({ type: "error.correlation", correlationId })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: errMsg })}\n\n`);
          agentSpan.setStatus({ code: SpanStatusCode.ERROR, message: "max_retries_exceeded" });
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
          res.write(`data: ${JSON.stringify({ type: "error.correlation", correlationId })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: errMsg })}\n\n`);
          agentSpan.setStatus({ code: SpanStatusCode.ERROR, message: "stream_timeout" });
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

          const contRes = await foundryFetch("/responses", {
            method: "POST",
            headers: { Accept: "text/event-stream" },
            body: JSON.stringify(buildResponseBody(
              [{ type: "response", id: responseId }],
            )),
          });
          if (!contRes.ok) {
            logger.error("Continuation HTTP failed", { round: continuationRound, status: contRes.status });
            const errMsg = "\n\n⚠️ I encountered an error while completing my analysis. Please try again.";
            assistantText += errMsg;
            res.write(`data: ${JSON.stringify({ type: "error.correlation", correlationId })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: errMsg })}\n\n`);
            break;
          }
          const contResult = await streamFoundryResponse(contRes, `cont#${continuationRound}`);
          assistantText += contResult.assistantChunk;
          responseId = contResult.responseId;
          lastStatus = contResult.status;
          lastOutput = contResult.output;

          if (!contResult.status) {
            logger.error("Continuation stream timeout", { round: continuationRound });
            const errMsg = "\n\n⚠️ The request timed out while completing the analysis. Please try again.";
            assistantText += errMsg;
            res.write(`data: ${JSON.stringify({ type: "error.correlation", correlationId })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: errMsg })}\n\n`);
            break;
          }
          if (contResult.status === "failed") {
            logger.error("Continuation response failed", { round: continuationRound });
            const errMsg = "\n\n⚠️ I had trouble completing that request. Could you try rephrasing or breaking it into smaller questions?";
            assistantText += errMsg;
            res.write(`data: ${JSON.stringify({ type: "error.correlation", correlationId })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: errMsg })}\n\n`);
            break;
          }
        }

        if (continuationRound >= MAX_CONTINUATIONS) {
          logger.warn("Max continuations reached", { round: continuationRound, max: MAX_CONTINUATIONS });
          const errMsg = "\n\n⚠️ This request required too many steps. Please try breaking it into smaller questions.";
          assistantText += errMsg;
          res.write(`data: ${JSON.stringify({ type: "error.correlation", correlationId })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: errMsg })}\n\n`);
        }

        agentSpan.setAttributes({ attempt: attempt + 1, continuations: continuationRound });
        // If we reached here without failure, we're done
        if (result.status !== "failed") break;
      }
      agentSpan.end();
      });
    } catch (streamErr) {
      logger.error("Stream error", { error: streamErr.message });
      try {
        const errMsg = "\n\n⚠️ I encountered an unexpected error. Please try again.";
        assistantText += errMsg;
        res.write(`data: ${JSON.stringify({ type: "error.correlation", correlationId })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: errMsg })}\n\n`);
      } catch { /* client gone */ }
    } finally {
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
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to process message", correlationId });
    }
  }
});

export default router;

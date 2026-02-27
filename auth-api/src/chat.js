// SunnieAI chat proxy — forwards chat requests to Azure AI Foundry Agent Service.
// Uses the new Foundry Responses API (not classic Assistants/Threads API).
// Manages conversation history locally with rolling summarization.
import { Router } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import config from "./config.js";
import {
  createThread, getUserThreads, deleteThread,
  addChatMessage, getChatMessages, getChatMessageCount,
  updateThreadSummary, getThreadSummary,
} from "./db.js";

const router = Router();

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

async function getAzureToken() {
  try {
    const { DefaultAzureCredential } = await import("@azure/identity");
    const credential = new DefaultAzureCredential();
    const token = await credential.getToken("https://ai.azure.com/.default");
    return token.token;
  } catch (err) {
    console.error("[chat] Failed to get Azure token:", err.message);
    throw err;
  }
}

async function foundryFetch(path, opts = {}) {
  const token = await getAzureToken();
  const url = `${OPENAI_BASE}${path}`;
  console.log(`[chat] Foundry request: ${opts.method || "GET"} ${url}`);
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...opts.headers,
    },
  });
  console.log(`[chat] Foundry response: ${res.status} ${res.statusText}`);
  return res;
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
    console.error("[chat] Failed to list threads:", err);
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
    console.error("[chat] Thread creation error:", err);
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
    console.error("[chat] Thread deletion error:", err);
    res.status(500).json({ error: "Failed to delete thread" });
  }
});

// ── Get messages for a thread ──────────────────────────────────
router.get("/threads/:threadId/messages", async (req, res) => {
  try {
    const messages = await getChatMessages(Number(req.params.threadId));
    // Return in the same format the frontend expects
    const data = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));
    res.json({ data });
  } catch (err) {
    console.error("[chat] Get messages error:", err);
    res.status(500).json({ error: "Failed to get messages" });
  }
});

// Build the input array for the Responses API with summarization
async function buildInput(threadId, newUserContent) {
  const messages = await getChatMessages(threadId);
  const summary = await getThreadSummary(threadId);
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
async function maybeSummarize(threadId) {
  try {
    const count = await getChatMessageCount(threadId);
    if (count <= SUMMARY_THRESHOLD) return;

    const messages = await getChatMessages(threadId);
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
        await updateThreadSummary(threadId, summaryText);
      }
    }
  } catch (err) {
    console.error("[chat] Summarization failed (non-critical):", err.message);
  }
}

// ── Send message and run agent (streaming) ─────────────────────
router.post("/threads/:threadId/messages", async (req, res) => {
  if (!FOUNDRY_ENDPOINT || !FOUNDRY_AGENT_NAME) {
    return res.status(503).json({ error: "AI service not configured" });
  }

  const { content } = req.body;
  if (!content) {
    return res.status(400).json({ error: "content is required" });
  }

  const threadId = Number(req.params.threadId);

  try {
    // 1. Build input with summarization (BEFORE storing the new message)
    const input = await buildInput(threadId, content);

    // 2. Store user message in DB
    await addChatMessage(threadId, "user", content);

    // 3. Create response (streaming) via Responses API
    const userJwt = req.cookies.access_token;
    const responseBody = {
      input,
      model: "gpt-5.2-chat",
      instructions: getAgentInstructions(),
      stream: true,
      store: false,
      max_output_tokens: 16384,
    };

    // Pass MCP tool with user's JWT so Foundry forwards auth to the MCP server.
    // Cannot use agent_reference + tools together, so we pass everything inline.
    if (MCP_SERVER_URL && userJwt) {
      responseBody.tools = [
        {
          type: "mcp",
          server_label: "actual-budget-mcp",
          server_url: `${MCP_SERVER_URL.replace(/\/+$/, "")}/mcp`,
          headers: { Authorization: `Bearer ${userJwt}` },
          require_approval: "never",
        },
      ];
    } else if (FOUNDRY_AGENT_NAME) {
      // Fallback: use registered agent (no per-user MCP auth)
      responseBody.agent_reference = {
        name: FOUNDRY_AGENT_NAME,
        version: "1",
        type: "agent_reference",
      };
    }

    const runRes = await foundryFetch(
      "/responses",
      {
        method: "POST",
        headers: { Accept: "text/event-stream" },
        body: JSON.stringify(responseBody),
      },
    );

    if (!runRes.ok) {
      const err = await runRes.text();
      console.error(`[chat] Response creation failed (${runRes.status}):`, err);
      const detail = err.substring(0, 500);
      return res.status(503).json({ error: "Failed to run agent", upstream_status: runRes.status, detail });
    }

    // 4. Stream SSE response to client
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const reader = runRes.body.getReader();
    const decoder = new TextDecoder();
    let assistantText = "";
    let sseBuffer = ""; // buffer partial SSE lines across chunks

    // Send SSE heartbeat every 15s to keep proxies from closing the connection
    const heartbeat = setInterval(() => {
      try { res.write(":heartbeat\n\n"); } catch { /* client gone */ }
    }, 15_000);

    try {
      const STREAM_TIMEOUT_MS = 300_000;
      let responseId = null;
      let lastResponseStatus = null;
      let lastResponseOutput = [];

      while (true) {
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("stream_timeout")), STREAM_TIMEOUT_MS),
        );
        let result;
        try {
          result = await Promise.race([reader.read(), timeout]);
        } catch {
          console.error("[chat] Stream inactivity timeout");
          reader.cancel();
          break;
        }
        const { done, value } = result;
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });

        // Parse SSE — buffer partial lines so events split across chunks
        // are not dropped (fixes response.completed being silently lost).
        sseBuffer += chunk;
        const sseLines = sseBuffer.split("\n");
        sseBuffer = sseLines.pop() || ""; // keep last (possibly incomplete) line

        for (const line of sseLines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const event = JSON.parse(data);
              // New Responses API format
              if (event.type === "response.output_text.delta" && event.delta) {
                assistantText += event.delta;
              }
              // Classic format fallback
              const classicDelta = event?.delta?.content?.[0]?.text?.value;
              if (classicDelta) {
                assistantText += classicDelta;
              }
              // Track response completion status for multi-turn continuation
              if (event.type === "response.completed" && event.response) {
                responseId = event.response.id;
                lastResponseStatus = event.response.status;
                lastResponseOutput = event.response.output || [];
                console.log(`[chat] Response completed: id=${responseId} status=${lastResponseStatus} outputs=${lastResponseOutput.length}`);
                for (const item of lastResponseOutput) {
                  console.log(`[chat]   output item: type=${item.type} ${item.type === "mcp_call" ? `name=${item.name} server=${item.server_label}` : ""}`);
                }
              }
              // Log important events for debugging
              if (event.type && !event.type.includes("delta")) {
                console.log(`[chat] SSE event: ${event.type}`);
              }
            } catch {
              // skip unparseable SSE lines
            }
          }
        }

        res.write(chunk);
      }

      // Auto-continue if: (a) response hit token limit (status=incomplete),
      // or (b) response ended with only tool outputs and no text.
      // Loop to support multi-turn tool-call chains.
      let continuationRound = 0;
      const MAX_CONTINUATIONS = 5;

      while (responseId && continuationRound < MAX_CONTINUATIONS) {
        const hasToolOutput = lastResponseOutput.some(o => o.type === "mcp_call");
        const hasTextOutput = lastResponseOutput.some(o => o.type === "message" || o.type === "text");
        const needsContinuation =
          lastResponseStatus === "incomplete" ||
          (hasToolOutput && !hasTextOutput);

        if (!needsContinuation) break;
        continuationRound++;
        console.log(`[chat] Continuation #${continuationRound}: status=${lastResponseStatus} outputs=${lastResponseOutput.length}`);

        // Reset tracking for this round
        const prevResponseId = responseId;
        responseId = null;
        lastResponseStatus = null;
        lastResponseOutput = [];

        try {
          const contRes = await foundryFetch("/responses", {
            method: "POST",
            headers: { Accept: "text/event-stream" },
            body: JSON.stringify({
              input: [{ type: "response", id: prevResponseId }],
              model: "gpt-5.2-chat",
              instructions: getAgentInstructions(),
              stream: true,
              store: false,
              max_output_tokens: 16384,
              tools: responseBody.tools,
            }),
          });
          if (!contRes.ok) {
            console.error(`[chat] Continuation #${continuationRound} failed: ${contRes.status}`);
            break;
          }
          const contReader = contRes.body.getReader();
          const contDecoder = new TextDecoder();
          let contSseBuffer = "";
          while (true) {
            let contResult;
            try {
              contResult = await Promise.race([
                contReader.read(),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error("cont_timeout")), STREAM_TIMEOUT_MS),
                ),
              ]);
            } catch {
              console.error(`[chat] Continuation #${continuationRound} stream timeout`);
              contReader.cancel();
              break;
            }
            const { done: contDone, value: contValue } = contResult;
            if (contDone) break;
            const contChunk = contDecoder.decode(contValue, { stream: true });
            contSseBuffer += contChunk;
            const contLines = contSseBuffer.split("\n");
            contSseBuffer = contLines.pop() || "";
            for (const line of contLines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6);
                if (data === "[DONE]") continue;
                try {
                  const event = JSON.parse(data);
                  if (event.type === "response.output_text.delta" && event.delta) {
                    assistantText += event.delta;
                  }
                  if (event.type === "response.completed" && event.response) {
                    responseId = event.response.id;
                    lastResponseStatus = event.response.status;
                    lastResponseOutput = event.response.output || [];
                    console.log(`[chat] Continuation #${continuationRound} completed: id=${responseId} status=${lastResponseStatus} outputs=${lastResponseOutput.length}`);
                  }
                  if (event.type && !event.type.includes("delta")) {
                    console.log(`[chat] SSE event (cont#${continuationRound}): ${event.type}`);
                  }
                } catch { /* skip */ }
              }
            }
            res.write(contChunk);
          }
        } catch (contErr) {
          console.error(`[chat] Continuation #${continuationRound} error:`, contErr);
          break;
        }
      }

      // Diagnostic: log if stream ended without response.completed
      if (!responseId && !assistantText) {
        console.warn("[chat] Stream ended without response.completed and no text collected");
      } else if (!responseId && assistantText) {
        console.warn("[chat] Stream ended without response.completed (text was collected, possible chunk-split)");
      }
    } catch (streamErr) {
      console.error("[chat] Stream error:", streamErr);
    } finally {
      clearInterval(heartbeat);
      res.end();
    }

    // 5. Store assistant response in DB (async, non-blocking)
    if (assistantText) {
      addChatMessage(threadId, "assistant", assistantText).catch(err =>
        console.error("[chat] Failed to store assistant message:", err),
      );
      // Trigger summarization in background
      maybeSummarize(threadId).catch(() => {});
    }
  } catch (err) {
    console.error("[chat] Message/run error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to process message" });
    }
  }
});

export default router;

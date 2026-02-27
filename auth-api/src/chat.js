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
const AGENT_INSTRUCTIONS =
  "You are SunnieAI, a personal finance assistant. " +
  "You have access to the user's Actual Budget data through MCP tools. " +
  "Use the available tools to help manage budgets, accounts, transactions, " +
  "categories, and more. Be friendly, concise, and helpful. " +
  "Confirm destructive actions before executing.\n\n" +
  AGENT_KNOWLEDGE;

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
        model: "gpt-4.1",
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
          model: "gpt-5",
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
      model: "gpt-5",
      instructions: AGENT_INSTRUCTIONS,
      stream: true,
      store: false,
      max_output_tokens: 4096,
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

    try {
      const STREAM_TIMEOUT_MS = 120_000;
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

        // Parse SSE to collect assistant text for DB storage
        for (const line of chunk.split("\n")) {
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
            } catch {
              // skip unparseable SSE lines
            }
          }
        }

        res.write(chunk);
      }
    } catch (streamErr) {
      console.error("[chat] Stream error:", streamErr);
    } finally {
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

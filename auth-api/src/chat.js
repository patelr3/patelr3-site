// SunnieAI chat proxy — forwards chat requests to Azure AI Foundry Agent Service.
// Auth-api authenticates the user (JWT cookie) and proxies to Foundry using
// Azure AD credentials, passing the user's JWT as an MCP tool header.
import { Router } from "express";
import config from "./config.js";
import { getOrCreateThread, getUserThreads, deleteThread } from "./db.js";

const router = Router();

// Azure AI Foundry config
const FOUNDRY_ENDPOINT = config.foundryProjectEndpoint;
const FOUNDRY_AGENT_ID = config.foundryAgentId;

async function getAzureToken() {
  // Use managed identity in ACA, DefaultAzureCredential locally
  const { DefaultAzureCredential } = await import("@azure/identity");
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken("https://ai.azure.com/.default");
  return token.token;
}

async function foundryFetch(path, opts = {}) {
  const token = await getAzureToken();
  const url = `${FOUNDRY_ENDPOINT}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...opts.headers,
    },
  });
  return res;
}

// ── Health check ───────────────────────────────────────────────
router.get("/health", (_req, res) => {
  res.json({
    configured: !!(FOUNDRY_ENDPOINT && FOUNDRY_AGENT_ID),
    endpoint: FOUNDRY_ENDPOINT ? "set" : "missing",
    agentId: FOUNDRY_AGENT_ID ? "set" : "missing",
  });
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
  if (!FOUNDRY_ENDPOINT) {
    return res.status(503).json({ error: "AI service not configured" });
  }

  try {
    const { title } = req.body;
    // Create thread in Foundry
    const foundryRes = await foundryFetch("/threads?api-version=v1", {
      method: "POST",
      body: JSON.stringify({}),
    });

    if (!foundryRes.ok) {
      const err = await foundryRes.text();
      console.error("[chat] Foundry thread creation failed:", err);
      return res.status(502).json({ error: "Failed to create AI thread" });
    }

    const foundryThread = await foundryRes.json();

    // Store mapping in our DB
    const thread = await getOrCreateThread(
      Number(req.jwtUser.sub),
      foundryThread.id,
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

    // Also delete in Foundry (best effort)
    if (FOUNDRY_ENDPOINT) {
      foundryFetch(`/threads/${req.params.threadId}?api-version=v1`, {
        method: "DELETE",
      }).catch(() => {});
    }

    res.json({ success: true });
  } catch (err) {
    console.error("[chat] Thread deletion error:", err);
    res.status(500).json({ error: "Failed to delete thread" });
  }
});

// ── Get messages for a thread ──────────────────────────────────
router.get("/threads/:threadId/messages", async (req, res) => {
  if (!FOUNDRY_ENDPOINT) {
    return res.status(503).json({ error: "AI service not configured" });
  }

  try {
    const foundryRes = await foundryFetch(
      `/threads/${req.params.threadId}/messages?api-version=v1`,
    );

    if (!foundryRes.ok) {
      return res.status(foundryRes.status).json({ error: "Failed to get messages" });
    }

    const data = await foundryRes.json();
    res.json(data);
  } catch (err) {
    console.error("[chat] Get messages error:", err);
    res.status(500).json({ error: "Failed to get messages" });
  }
});

// ── Send message and run agent (streaming) ─────────────────────
router.post("/threads/:threadId/messages", async (req, res) => {
  if (!FOUNDRY_ENDPOINT || !FOUNDRY_AGENT_ID) {
    return res.status(503).json({ error: "AI service not configured" });
  }

  const { content } = req.body;
  if (!content) {
    return res.status(400).json({ error: "content is required" });
  }

  try {
    // 1. Add user message to thread
    const msgRes = await foundryFetch(
      `/threads/${req.params.threadId}/messages?api-version=v1`,
      {
        method: "POST",
        body: JSON.stringify({
          role: "user",
          content,
        }),
      },
    );

    if (!msgRes.ok) {
      const err = await msgRes.text();
      console.error("[chat] Add message failed:", err);
      return res.status(502).json({ error: "Failed to add message" });
    }

    // 2. Create run (streaming)
    const runRes = await foundryFetch(
      `/threads/${req.params.threadId}/runs?api-version=v1`,
      {
        method: "POST",
        headers: { Accept: "text/event-stream" },
        body: JSON.stringify({
          assistant_id: FOUNDRY_AGENT_ID,
          stream: true,
        }),
      },
    );

    if (!runRes.ok) {
      const err = await runRes.text();
      console.error("[chat] Run creation failed:", err);
      return res.status(502).json({ error: "Failed to run agent" });
    }

    // 4. Stream SSE response to client
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const reader = runRes.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
      }
    } catch (streamErr) {
      console.error("[chat] Stream error:", streamErr);
    } finally {
      res.end();
    }
  } catch (err) {
    console.error("[chat] Message/run error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to process message" });
    }
  }
});

export default router;

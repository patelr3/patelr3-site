import { useState, useEffect, useRef } from "react";

const MCP_SERVERS = [
  { id: "actualbudget", name: "Actual Budget", description: "Personal finance data" },
];

export default function SunnieAI({ user }) {
  const [threads, setThreads] = useState([]);
  const [activeThread, setActiveThread] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [enabledServers, setEnabledServers] = useState(["actualbudget"]);
  const [showSettings, setShowSettings] = useState(false);
  const [configured, setConfigured] = useState(null);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Check if AI service is configured
  useEffect(() => {
    fetch("/api/auth/chat/health", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => setConfigured(data.configured))
      .catch(() => setConfigured(false));
  }, []);

  // Load threads
  useEffect(() => {
    fetch("/api/auth/chat/threads", { credentials: "include" })
      .then((r) => r.json())
      .then(setThreads)
      .catch(() => {});
  }, []);

  // Load messages when thread changes
  useEffect(() => {
    if (!activeThread) {
      setMessages([]);
      return;
    }
    fetch(`/api/auth/chat/threads/${activeThread}/messages`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        const msgs = (data.data || [])
          .map((m) => ({
            role: m.role,
            content: m.content?.[0]?.text?.value || m.content || "",
          }))
          .reverse();
        setMessages(msgs);
      })
      .catch(() => {});
  }, [activeThread]);

  const createThread = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/auth/chat/threads", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New conversation" }),
      });
      const thread = await res.json();
      setThreads((prev) => [thread, ...prev]);
      setActiveThread(thread.foundry_thread_id);
      setMessages([]);
    } catch {
      // ignore
    }
    setLoading(false);
  };

  const deleteThreadHandler = async (threadId) => {
    await fetch(`/api/auth/chat/threads/${threadId}`, {
      method: "DELETE",
      credentials: "include",
    });
    setThreads((prev) => prev.filter((t) => t.foundry_thread_id !== threadId));
    if (activeThread === threadId) {
      setActiveThread(null);
      setMessages([]);
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || streaming) return;
    if (!activeThread) {
      await createThread();
    }

    const userMsg = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setStreaming(true);

    // Add placeholder for assistant response
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      const threadId = activeThread || threads[0]?.foundry_thread_id;
      const res = await fetch(`/api/auth/chat/threads/${threadId}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: userMsg,
          mcpServers: enabledServers,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: `Error: ${err.error || "Something went wrong"}`,
          };
          return updated;
        });
        setStreaming(false);
        return;
      }

      // Parse SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process SSE events
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const event = JSON.parse(data);
              // Extract text delta from various event shapes
              const delta =
                event?.delta?.content?.[0]?.text?.value ||
                event?.delta?.content ||
                "";
              if (delta) {
                assistantText += delta;
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: "assistant",
                    content: assistantText,
                  };
                  return updated;
                });
              }
            } catch {
              // skip unparseable events
            }
          }
        }
      }

      // If no streaming text came through, fetch final messages
      if (!assistantText) {
        const msgRes = await fetch(
          `/api/auth/chat/threads/${threadId}/messages`,
          { credentials: "include" },
        );
        const msgData = await msgRes.json();
        const allMsgs = (msgData.data || [])
          .map((m) => ({
            role: m.role,
            content: m.content?.[0]?.text?.value || m.content || "",
          }))
          .reverse();
        setMessages(allMsgs);
      }
    } catch {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: "assistant",
          content: "Connection error. Please try again.",
        };
        return updated;
      });
    }
    setStreaming(false);
  };

  const toggleServer = (id) => {
    setEnabledServers((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  };

  if (configured === false) {
    return (
      <div className="page sunnieai">
        <h1>☀️ SunnieAI</h1>
        <p className="sunnieai-subtitle">AI assistant is not yet configured. Deploy the Azure AI Foundry infrastructure first.</p>
      </div>
    );
  }

  return (
    <div className="page sunnieai">
      <div className="sunnieai-header">
        <h1>☀️ SunnieAI</h1>
        <button
          className="sunnieai-settings-btn"
          onClick={() => setShowSettings(!showSettings)}
          title="Toggle MCP servers"
        >
          ⚙️ Tools
        </button>
      </div>

      {showSettings && (
        <div className="sunnieai-settings">
          <h3>MCP Servers</h3>
          <p className="sunnieai-settings-desc">Toggle which data sources the AI can access:</p>
          {MCP_SERVERS.map((server) => (
            <label key={server.id} className="sunnieai-toggle">
              <input
                type="checkbox"
                checked={enabledServers.includes(server.id)}
                onChange={() => toggleServer(server.id)}
              />
              <span className="sunnieai-toggle-label">
                <strong>{server.name}</strong>
                <small>{server.description}</small>
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="sunnieai-layout">
        {/* Thread sidebar */}
        <div className="sunnieai-sidebar">
          <button className="sunnieai-new-btn" onClick={createThread} disabled={loading}>
            + New Chat
          </button>
          {threads.map((t) => (
            <div
              key={t.foundry_thread_id}
              className={`sunnieai-thread ${activeThread === t.foundry_thread_id ? "active" : ""}`}
            >
              <span
                className="sunnieai-thread-title"
                onClick={() => setActiveThread(t.foundry_thread_id)}
              >
                {t.title}
              </span>
              <button
                className="sunnieai-thread-delete"
                onClick={() => deleteThreadHandler(t.foundry_thread_id)}
                title="Delete"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {/* Chat area */}
        <div className="sunnieai-chat">
          <div className="sunnieai-messages">
            {messages.length === 0 && (
              <div className="sunnieai-empty">
                <p>👋 Hi {user?.name?.split(" ")[0] || "there"}! I'm SunnieAI.</p>
                <p>Ask me about your finances, budgets, or transactions.</p>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`sunnieai-msg sunnieai-msg-${msg.role}`}>
                <div className="sunnieai-msg-avatar">
                  {msg.role === "user" ? "👤" : "☀️"}
                </div>
                <div className="sunnieai-msg-content">
                  {msg.content || (streaming && i === messages.length - 1 ? "Thinking..." : "")}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <div className="sunnieai-input">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              placeholder={activeThread ? "Type a message..." : "Start a new conversation..."}
              disabled={streaming}
            />
            <button onClick={sendMessage} disabled={streaming || !input.trim()}>
              {streaming ? "..." : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

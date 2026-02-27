import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
  const [listening, setListening] = useState(false);
  const [agentStatus, setAgentStatus] = useState(null);
  const recognitionRef = useRef(null);
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const skipMessageFetchRef = useRef(false);
  const [inputFocused, setInputFocused] = useState(false);

  // Scroll messages container to bottom on new messages (history load, etc.)
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages]);

  // Pin scroll to bottom continuously while streaming (handles gaps between events)
  useEffect(() => {
    if (!streaming) return;
    const container = messagesContainerRef.current;
    if (!container) return;
    const id = setInterval(() => {
      container.scrollTop = container.scrollHeight;
    }, 150);
    return () => clearInterval(id);
  }, [streaming]);

  // Check if AI service is configured
  useEffect(() => {
    fetch("/api/auth/chat/health", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => setConfigured(data.configured))
      .catch(() => setConfigured(false));
  }, []);

  // Speech recognition (Web Speech API)
  const speechSupported = typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  const toggleListening = useCallback(() => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = true;

    let finalTranscript = "";

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      setInput(finalTranscript + interim);
    };

    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [listening]);

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
    // Skip fetch when thread was just created (sendMessage handles messages)
    if (skipMessageFetchRef.current) {
      skipMessageFetchRef.current = false;
      return;
    }
    fetch(`/api/auth/chat/threads/${activeThread}/messages`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        const msgs = (data.data || [])
          .map((m) => ({
            role: m.role,
            content: m.content || "",
          }));
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
      skipMessageFetchRef.current = true;
      setActiveThread(thread.id);
      setMessages([]);
      setLoading(false);
      return thread;
    } catch {
      setLoading(false);
      return null;
    }
  };

  const deleteThreadHandler = async (threadId) => {
    await fetch(`/api/auth/chat/threads/${threadId}`, {
      method: "DELETE",
      credentials: "include",
    });
    setThreads((prev) => prev.filter((t) => String(t.id) !== String(threadId)));
    if (String(activeThread) === String(threadId)) {
      setActiveThread(null);
      setMessages([]);
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || streaming) return;
    let threadId = activeThread;
    if (!threadId) {
      const thread = await createThread();
      if (!thread) return;
      threadId = thread.id;
    }

    const userMsg = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setStreaming(true);

    // Add placeholder for assistant response
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
    setAgentStatus("Thinking…");

    try {
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

      // Parse SSE stream with inactivity timeout
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";
      const STREAM_TIMEOUT_MS = 300_000;

      while (true) {
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), STREAM_TIMEOUT_MS),
        );
        let result;
        try {
          result = await Promise.race([reader.read(), timeout]);
        } catch {
          reader.cancel();
          if (!assistantText) {
            assistantText = "Response timed out. Please try again.";
            setMessages((prev) => {
              const updated = [...prev];
              updated[updated.length - 1] = { role: "assistant", content: assistantText };
              return updated;
            });
          }
          break;
        }
        const { done, value } = result;
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
              // Extract text delta — new Responses API format + classic fallback
              const delta =
                (event.type === "response.output_text.delta" && event.delta) ||
                event?.delta?.content?.[0]?.text?.value ||
                event?.delta?.content ||
                "";
              if (delta) {
                assistantText += delta;
                setAgentStatus(null);
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: "assistant",
                    content: assistantText,
                  };
                  return updated;
                });
              } else if (event.type) {
                // Track agent activity for status indicator
                if (event.type.includes("mcp_call") && event.type.includes("completed")) {
                  setAgentStatus("Thinking…");
                } else if (event.type.includes("mcp_call")) {
                  const label = event.item?.server_label || "";
                  setAgentStatus(label ? `Using ${label}…` : "Looking up data…");
                } else if (event.type === "response.in_progress") {
                  setAgentStatus("Thinking…");
                }
                // Don't clear on response.completed — multi-step responses
                // send this between steps, not just at the end
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
    setAgentStatus(null);
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
              key={t.id}
              className={`sunnieai-thread ${activeThread === t.id ? "active" : ""}`}
            >
              <span
                className="sunnieai-thread-title"
                onClick={() => setActiveThread(t.id)}
              >
                {t.title}
              </span>
              <button
                className="sunnieai-thread-delete"
                onClick={() => deleteThreadHandler(t.id)}
                title="Delete"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {/* Chat area */}
        <div className="sunnieai-chat">
          <div className="sunnieai-messages" ref={messagesContainerRef}>
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
                  {msg.role === "assistant" ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.content || (streaming && i === messages.length - 1 && agentStatus ? agentStatus : "")}
                    </ReactMarkdown>
                  ) : (
                    msg.content || ""
                  )}
                </div>
              </div>
            ))}
            {streaming && agentStatus && messages.length > 0 && messages[messages.length - 1]?.content && (
              <div className="sunnieai-status">
                <span className="sunnieai-status-dots"><span /><span /><span /></span>
                {agentStatus}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className={`sunnieai-input ${inputFocused ? "focused" : ""}`}>
            <textarea
              rows={inputFocused ? 3 : 1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              placeholder={activeThread ? "Type a message..." : "Start a new conversation..."}
              disabled={streaming}
            />
            {speechSupported && (
              <button
                className={`sunnieai-mic-btn ${listening ? "listening" : ""}`}
                onClick={toggleListening}
                disabled={streaming}
                title={listening ? "Stop recording" : "Voice input"}
                aria-label={listening ? "Stop recording" : "Voice input"}
              >
                {listening ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="1" width="6" height="12" rx="3" />
                    <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
                    <line x1="12" y1="18" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                )}
              </button>
            )}
            <button onClick={sendMessage} disabled={streaming || !input.trim()}>
              {streaming ? "..." : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

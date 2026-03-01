import { useState, useRef, useEffect } from "react";
import { authFetch } from "../App";
import api from "../api";

export default function SunnieAI() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const [consentLink, setConsentLink] = useState(null);
  const [pendingRetry, setPendingRetry] = useState(null);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function ensureConversation() {
    if (conversationId) return conversationId;
    const res = await authFetch(api.chatConversations(), { method: "POST" });
    if (!res.ok) throw new Error("Failed to create conversation");
    const data = await res.json();
    setConversationId(data.conversationId);
    return data.conversationId;
  }

  async function sendMessage(text, previousResponseId = null) {
    if (!text.trim()) return;

    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setLoading(true);
    setConsentLink(null);

    try {
      const convId = await ensureConversation();
      const body = { message: text };
      if (previousResponseId) body.previousResponseId = previousResponseId;

      const res = await authFetch(api.chatMessages(convId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error(`Server error: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";

      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let eventType = null;
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ") && eventType) {
            const data = JSON.parse(line.slice(6));
            handleSseEvent(eventType, data, text);
            eventType = null;
          }
        }
      }

      function handleSseEvent(type, data, originalText) {
        switch (type) {
          case "text_delta":
            assistantText += data.delta;
            setMessages((prev) => {
              const updated = [...prev];
              updated[updated.length - 1] = { role: "assistant", content: assistantText };
              return updated;
            });
            break;

          case "message":
            assistantText = data.text;
            setMessages((prev) => {
              const updated = [...prev];
              updated[updated.length - 1] = { role: "assistant", content: data.text };
              return updated;
            });
            break;

          case "oauth_consent":
            setConsentLink(data.consentLink);
            setPendingRetry({ text: originalText, responseId: data.responseId });
            setMessages((prev) => {
              const updated = [...prev];
              updated[updated.length - 1] = {
                role: "assistant",
                content: "I need access to your budget data. Please click the button below to authorize.",
              };
              return updated;
            });
            break;

          case "error":
            setMessages((prev) => {
              const updated = [...prev];
              updated[updated.length - 1] = {
                role: "assistant",
                content: `Error: ${data.error}`,
              };
              return updated;
            });
            break;
        }
      }
    } catch (err) {
      setMessages((prev) => {
        const updated = [...prev];
        if (updated.length > 0 && updated[updated.length - 1].role === "assistant" && !updated[updated.length - 1].content) {
          updated[updated.length - 1] = { role: "assistant", content: `Error: ${err.message}` };
        } else {
          updated.push({ role: "assistant", content: `Error: ${err.message}` });
        }
        return updated;
      });
    } finally {
      setLoading(false);
    }
  }

  function handleConsent() {
    if (!consentLink) return;
    const popup = window.open(consentLink, "oauth_consent", "width=600,height=700");
    const interval = setInterval(() => {
      if (popup?.closed) {
        clearInterval(interval);
        setConsentLink(null);
        if (pendingRetry) {
          sendMessage(pendingRetry.text, pendingRetry.responseId);
          setPendingRetry(null);
        }
      }
    }, 500);
  }

  function handleNewChat() {
    setMessages([]);
    setConversationId(null);
    setConsentLink(null);
    setPendingRetry(null);
  }

  function handleSubmit(e) {
    e.preventDefault();
    sendMessage(input);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  return (
    <div className="page sunnieai">
      <div className="sunnieai-header">
        <div>
          <h1>SunnieAI</h1>
          <p className="sunnieai-subtitle">Your AI budget assistant</p>
        </div>
        <button className="sunnieai-new-btn" onClick={handleNewChat}>
          + New Chat
        </button>
      </div>

      <div className="sunnieai-chat">
        <div className="sunnieai-messages">
          {messages.length === 0 && (
            <div className="sunnieai-empty">
              <p>👋 Hi! I&apos;m SunnieAI.</p>
              <p>Ask me about your budget, transactions, or accounts.</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`sunnieai-msg sunnieai-msg-${msg.role}`}>
              <span className="sunnieai-msg-avatar">{msg.role === "user" ? "👤" : "🤖"}</span>
              <div className="sunnieai-msg-content">{msg.content}</div>
            </div>
          ))}
          {loading && (
            <div className="sunnieai-status">
              <div className="sunnieai-status-dots">
                <span /><span /><span />
              </div>
              SunnieAI is thinking...
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {consentLink && (
          <div style={{ padding: "0.75rem", borderTop: "1px solid #e0e0e0", textAlign: "center" }}>
            <button onClick={handleConsent} className="sunnieai-new-btn">
              🔑 Authorize Budget Access
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="sunnieai-input">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your budget..."
            disabled={loading}
            rows={1}
          />
          <button type="submit" disabled={loading || !input.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

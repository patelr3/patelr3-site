import { useState } from "react";
import api from "../api";

export default function Dashboard({ user }) {
  const [helloResponse, setHelloResponse] = useState(null);
  const [loading, setLoading] = useState(false);

  const callHelloWorld = async () => {
    setLoading(true);
    try {
      const res = await fetch(api.hello(), { credentials: "include" });
      const data = await res.json();
      setHelloResponse(JSON.stringify(data, null, 2));
    } catch (err) {
      setHelloResponse(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page dashboard">
      <h2>Dashboard</h2>
      <p style={{ marginBottom: "1rem", color: "#555" }}>
        Signed in as <strong>{user?.email}</strong> (role: {user?.role})
      </p>

      <div className="service-card">
        <h3>🌍 Hello-World Service</h3>
        <p>A sample micro-service running in its own container.</p>
        <button onClick={callHelloWorld} disabled={loading}>
          {loading ? "Calling…" : "Call Service"}
        </button>
        {helloResponse && <div className="response">{helloResponse}</div>}
      </div>
    </div>
  );
}

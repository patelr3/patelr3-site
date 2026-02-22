import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api from "../api";

export default function ServicePage({ user }) {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [service, setService] = useState(null);
  const [response, setResponse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [calling, setCalling] = useState(false);

  useEffect(() => {
    fetch(api.services(), { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((svcs) => {
        const svc = svcs.find((s) => s.slug === slug);
        if (!svc || !svc.hasAccess) {
          navigate("/dashboard");
          return;
        }
        setService(svc);
      })
      .catch(() => navigate("/dashboard"))
      .finally(() => setLoading(false));
  }, [slug, navigate]);

  const callService = async () => {
    if (!service) return;
    setCalling(true);
    try {
      const url = api.serviceEndpoint(service.slug === "hello-world-restricted"
        ? "/api/hello-restricted/"
        : "/api/hello/");
      const res = await fetch(url, { credentials: "include" });
      const data = await res.json();
      setResponse(JSON.stringify(data, null, 2));
    } catch (err) {
      setResponse(`Error: ${err.message}`);
    } finally {
      setCalling(false);
    }
  };

  if (loading) return <div className="page"><p>Loading…</p></div>;
  if (!service) return null;

  return (
    <div className="page">
      <button className="back-btn" onClick={() => navigate("/dashboard")}>
        ← Back to Dashboard
      </button>
      <div className="service-card" style={{ marginTop: "1rem" }}>
        <h2>{service.name}</h2>
        <p>{service.description}</p>
        <button onClick={callService} disabled={calling}>
          {calling ? "Calling…" : "Call Service"}
        </button>
        {response && <div className="response">{response}</div>}
      </div>
    </div>
  );
}

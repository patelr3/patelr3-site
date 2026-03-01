import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { authFetch } from "../App";
import api from "../api";

export default function Dashboard({ user }) {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    authFetch(api.services())
      .then((r) => (r.ok ? r.json() : []))
      .then(setServices)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const requestAccess = async (serviceId) => {
    const res = await authFetch(api.accessRequests(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceId }),
    });
    if (res.ok || res.status === 409) {
      setServices((prev) =>
        prev.map((s) => (s.id === serviceId ? { ...s, pendingRequest: true } : s))
      );
    }
  };

  if (loading) return <div className="page"><p>Loading…</p></div>;

  return (
    <div className="page dashboard">
      <h2>Dashboard</h2>
      <p style={{ marginBottom: "1rem", color: "#555" }}>
        Signed in as <strong>{user?.email}</strong>
      </p>

      {services.length === 0 && <p>No services available.</p>}

      {services.map((svc) => (
        <div key={svc.id} className="service-card">
          <h3>{svc.name}</h3>
          <p>{svc.description}</p>
          {!svc.isVisible && (
            <span className="badge badge-hidden">Hidden</span>
          )}
          {svc.isRestricted && (
            <span className="badge badge-restricted">Restricted</span>
          )}

          {svc.hasAccess ? (
            <button onClick={() => navigate(`/services/${svc.slug}`)}>
              Open Service
            </button>
          ) : svc.pendingRequest ? (
            <button disabled className="btn-pending">Access Requested</button>
          ) : (
            <button className="btn-request" onClick={() => requestAccess(svc.id)}>
              Request Access
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

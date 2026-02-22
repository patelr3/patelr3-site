import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api from "../api";

const DEPLOYABLE_SERVICES = ["actualbudget"];

const SERVICE_DETAILS = {
  "hello-world": {
    purpose:
      "A lightweight REST API that returns a JSON greeting. It exists to demonstrate how a containerized Node.js microservice is built, deployed, and secured behind authentication.",
    architecture: [
      "Built with Express on Node.js 20, running in its own Docker container.",
      "Protected by JWT cookie authentication — only signed-in users can call it.",
      "Deployed as an Azure Container App with HTTP scaling rules.",
      "Requests are routed through an Nginx reverse proxy in the frontend container so the call stays same-origin (important for mobile browsers).",
    ],
  },
  "hello-world-restricted": {
    purpose:
      "Identical to Hello World, but wrapped in role-based access control (RBAC). Users must request access and receive admin approval before they can call the endpoint.",
    architecture: [
      "Same Express / Node.js stack as Hello World, in a separate container.",
      "An auth-api middleware checks the user's access grants before forwarding the request.",
      "Access requests are stored in Postgres and surfaced in the Admin Panel for approval or denial.",
      "Demonstrates a multi-tenant permission model layered on top of a simple service.",
    ],
  },
  actualbudget: {
    purpose:
      "Actual Budget is an open-source personal finance tool. This service provisions a private Actual Budget instance for each user, fully isolated in the cloud.",
    docsUrl: "https://actualbudget.org/docs/",
    architecture: [
      "Each user gets a dedicated Azure Container App running the Actual Budget server image.",
      "Persistent data is stored on an Azure File Share unique to the user, mounted into the container.",
      "Provisioning, status polling, and teardown are managed by a deployment API in auth-api.",
      "Instances scale to zero when idle, so they only consume resources while in use.",
    ],
    diagram: `
┌─────────────┐       ┌──────────────────┐       ┌──────────────────────────┐
│   Browser   │──────▶│  Frontend Nginx  │──────▶│        auth-api          │
│  (User)     │  HTTPS│  (reverse proxy) │ /api/ │  ┌────────────────────┐  │
└─────────────┘       └──────────────────┘       │  │  Deployment API    │  │
                                                 │  │  POST /deploy/:slug│  │
                                                 │  └────────┬───────────┘  │
                                                 └───────────┼──────────────┘
                                                             │ ARM / Bicep
                                                             ▼
                                          ┌──────────────────────────────────┐
                                          │     Azure Container Apps Env     │
                                          │                                  │
                                          │  ┌────────────────────────────┐  │
                                          │  │  User's Actual Budget ACA  │  │
                                          │  │  (dedicated per user)      │  │
                                          │  └────────────┬───────────────┘  │
                                          │               │ mount            │
                                          │  ┌────────────▼───────────────┐  │
                                          │  │  Azure File Share          │  │
                                          │  │  (persistent user data)    │  │
                                          │  └────────────────────────────┘  │
                                          └──────────────────────────────────┘`,
  },
};

export default function ServicePage({ user }) {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [service, setService] = useState(null);
  const [response, setResponse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [calling, setCalling] = useState(false);

  // Deployment state for deployable services
  const [deploy, setDeploy] = useState(null);
  const [deployLoading, setDeployLoading] = useState(false);
  const [deployAction, setDeployAction] = useState("");

  const isDeployable = DEPLOYABLE_SERVICES.includes(slug);

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

  // Fetch deployment status for deployable services
  useEffect(() => {
    if (!isDeployable || !service) return;
    fetchDeployStatus();
  }, [isDeployable, service]);

  const fetchDeployStatus = async () => {
    try {
      const res = await fetch(api.deploymentStatus(slug), { credentials: "include" });
      const data = await res.json();
      setDeploy(data);
    } catch {
      setDeploy({ status: "error", message: "Could not reach deployment service" });
    }
  };

  const deploymentAction = async (method) => {
    setDeployLoading(true);
    setDeployAction(method === "POST" ? "Creating" : method === "PUT" ? "Updating" : "Deleting");
    try {
      const res = await fetch(api.deploymentStatus(slug), { method, credentials: "include" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDeploy({ status: "error", message: data.error || `Action failed (${res.status})` });
        return;
      }
      // Poll status after action
      await new Promise((r) => setTimeout(r, 2000));
      await fetchDeployStatus();
    } catch {
      setDeploy({ status: "error", message: "Action failed" });
    } finally {
      setDeployLoading(false);
      setDeployAction("");
    }
  };

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

        {isDeployable ? (
          <DeploymentPanel
            deploy={deploy}
            loading={deployLoading}
            action={deployAction}
            onAction={deploymentAction}
            onRefresh={fetchDeployStatus}
          />
        ) : (
          <>
            <button onClick={callService} disabled={calling}>
              {calling ? "Calling…" : "Call Service"}
            </button>
            {response && <div className="response">{response}</div>}
          </>
        )}
      </div>

      {SERVICE_DETAILS[slug] && (
        <div className="service-details">
          <h3>About This Service</h3>
          <p>{SERVICE_DETAILS[slug].purpose}</p>

          {SERVICE_DETAILS[slug].docsUrl && (
            <p>
              📖{" "}
              <a
                href={SERVICE_DETAILS[slug].docsUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                View official documentation ↗
              </a>
            </p>
          )}

          <h4>Architecture</h4>
          <ul>
            {SERVICE_DETAILS[slug].architecture.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>

          {SERVICE_DETAILS[slug].diagram && (
            <>
              <h4>Service Architecture</h4>
              <pre className="arch-diagram">{SERVICE_DETAILS[slug].diagram}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DeploymentPanel({ deploy, loading, action, onAction, onRefresh }) {
  if (!deploy) return <p>Checking deployment status…</p>;

  const { status, fqdn, message } = deploy;

  return (
    <div className="deployment-panel">
      <div className="deployment-status">
        <strong>Status: </strong>
        <span className={`deploy-badge deploy-${status}`}>
          {status === "not_created" && "Not Created"}
          {status === "provisioning" && "Creation in progress…"}
          {status === "running" && "Running"}
          {status === "error" && "Error"}
          {status === "not_configured" && "Not Available"}
        </span>
      </div>

      {status === "running" && fqdn && (
        <div style={{ margin: "1rem 0" }}>
          <a href={fqdn} target="_blank" rel="noopener noreferrer" className="open-link">
            Open Actual Budget ↗
          </a>
        </div>
      )}

      {status === "error" && (
        <p className="deploy-error">
          {message || "Something went wrong. Contact site admin."}
        </p>
      )}

      <div className="deployment-actions">
        {status === "not_created" && (
          <button onClick={() => onAction("POST")} disabled={loading}>
            {loading && action === "Creating" ? "Creating…" : "Create Instance"}
          </button>
        )}

        {status === "running" && (
          <>
            <button className="danger-btn" onClick={() => {
              if (confirm("Delete your Actual Budget instance? Your data will be preserved in backups.")) {
                onAction("DELETE");
              }
            }} disabled={loading}>
              {loading && action === "Deleting" ? "Deleting…" : "Delete Instance"}
            </button>
          </>
        )}

        {status === "provisioning" && (
          <>
            <button onClick={onRefresh} disabled={loading}>Refresh Status</button>
            <button className="danger-btn" onClick={() => {
              if (confirm("Force delete? This will cancel the in-progress deployment.")) {
                onAction("DELETE");
              }
            }} disabled={loading}>
              Force Delete
            </button>
          </>
        )}

        {status === "error" && (
          <button className="danger-btn" onClick={() => {
            if (confirm("Delete the failed deployment?")) {
              onAction("DELETE");
            }
          }} disabled={loading}>
            Delete Instance
          </button>
        )}
      </div>
    </div>
  );
}

import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import config from "./config.js";
import {
  upsertFirebaseUser, findUserByEmail,
  listServices, getServiceBySlug, updateService,
  getUserAccess, grantAccess,
  createAccessRequest, listAccessRequests, updateAccessRequest, getUserPendingRequests,
  findUserById, listUsers, updateUserRole, touchLastLogin, deleteUser,
} from "./db.js";
import oidcRouter from "./oidc.js";

// Initialize Firebase Admin SDK (uses GOOGLE_APPLICATION_CREDENTIALS or ADC)
initializeApp({ projectId: config.firebaseProjectId });

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Session middleware — only used by OIDC redirect flow (deferred migration)
app.use(
  session({
    secret: config.jwtSecret,
    resave: false,
    saveUninitialized: false,
  })
);

// CORS — allow frontend origin for cross-origin API calls in production
const allowedOrigins = [config.frontendUrl];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Firebase auth middleware ────────────────────────────────────

async function requireAuth(req, res, next) {
  // Accept Firebase ID token from Authorization header or cookie
  let idToken = null;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    idToken = authHeader.slice(7);
  } else if (req.cookies?.access_token) {
    idToken = req.cookies.access_token;
  }
  if (!idToken) return res.status(401).json({ error: "Not authenticated" });

  try {
    const decoded = await getAuth().verifyIdToken(idToken);
    // Upsert user in our DB on every authenticated request
    const user = await upsertFirebaseUser(decoded);
    req.firebaseUser = decoded;
    req.dbUser = user;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
}

function requireAdmin(req, res, next) {
  if (req.dbUser?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// ── Current user / verify / logout ─────────────────────────────

app.get("/auth/me", requireAuth, async (req, res) => {
  res.json({
    authenticated: true,
    email: req.dbUser.email,
    name: req.dbUser.display_name,
    role: req.dbUser.role,
  });
});

app.get("/auth/verify", requireAuth, async (req, res) => {
  res.set("X-Auth-User", req.dbUser.email || "");
  res.set("X-Auth-Role", req.dbUser.role || "");
  res.sendStatus(200);
});

app.get("/auth/logout", (_req, res) => {
  res.clearCookie("access_token", {
    path: "/",
    sameSite: "lax",
    secure: config.frontendUrl.startsWith("https"),
  });
  res.redirect(config.frontendUrl);
});

// ── Service endpoints ──────────────────────────────────────────

app.get("/auth/services", requireAuth, async (req, res) => {
  try {
    const services = await listServices();
    const isAdmin = req.dbUser.role === "admin";
    const userId = Number(req.dbUser.id);
    const accessIds = await getUserAccess(userId);
    const pendingIds = await getUserPendingRequests(userId);

    const visible = services
      .filter((s) => isAdmin || s.is_visible)
      .map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        description: s.description,
        isVisible: s.is_visible,
        isRestricted: s.is_restricted,
        hasAccess: isAdmin || !s.is_restricted || accessIds.includes(s.id),
        pendingRequest: pendingIds.includes(s.id),
      }));

    res.json(visible);
  } catch (err) {
    res.status(500).json({ error: "Failed to list services" });
  }
});

app.patch("/auth/services/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { isVisible, isRestricted } = req.body;
    const fields = {};
    if (typeof isVisible === "boolean") fields.is_visible = isVisible;
    if (typeof isRestricted === "boolean") fields.is_restricted = isRestricted;
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }
    const updated = await updateService(Number(req.params.id), fields);
    if (!updated) return res.status(404).json({ error: "Service not found" });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Failed to update service" });
  }
});

// ── Access request endpoints ───────────────────────────────────

app.post("/auth/access-requests", requireAuth, async (req, res) => {
  try {
    const { serviceId } = req.body;
    if (!serviceId) return res.status(400).json({ error: "serviceId is required" });
    const request = await createAccessRequest(Number(req.dbUser.id), serviceId);
    if (!request) return res.status(409).json({ error: "Request already pending" });
    res.status(201).json(request);
  } catch (err) {
    res.status(500).json({ error: "Failed to create access request" });
  }
});

app.get("/auth/access-requests", requireAuth, requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || "pending";
    const requests = await listAccessRequests(status);
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: "Failed to list access requests" });
  }
});

app.post("/auth/access-requests/:id/approve", requireAuth, requireAdmin, async (req, res) => {
  try {
    const ar = await updateAccessRequest(Number(req.params.id), "approved", Number(req.dbUser.id));
    if (!ar) return res.status(404).json({ error: "Request not found" });
    await grantAccess(ar.user_id, ar.service_id);
    res.json(ar);
  } catch (err) {
    res.status(500).json({ error: "Failed to approve request" });
  }
});

app.post("/auth/access-requests/:id/deny", requireAuth, requireAdmin, async (req, res) => {
  try {
    const ar = await updateAccessRequest(Number(req.params.id), "denied", Number(req.dbUser.id));
    if (!ar) return res.status(404).json({ error: "Request not found" });
    res.json(ar);
  } catch (err) {
    res.status(500).json({ error: "Failed to deny request" });
  }
});

// ── Account endpoints ───────────────────────────────────────────

app.get("/auth/account", requireAuth, async (req, res) => {
  try {
    const user = req.dbUser;
    res.json({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      provider: req.firebaseUser.firebase?.sign_in_provider || "unknown",
      createdAt: user.created_at,
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch account" });
  }
});

// ── Admin: user management ─────────────────────────────────────

app.get("/auth/users", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const users = await listUsers();
    res.json(users);
  } catch {
    res.status(500).json({ error: "Failed to list users" });
  }
});

app.patch("/auth/users/:id/role", requireAuth, requireAdmin, async (req, res) => {
  const { role } = req.body;
  if (!role || !["user", "admin"].includes(role)) {
    return res.status(400).json({ error: "Role must be 'user' or 'admin'" });
  }
  try {
    const updated = await updateUserRole(Number(req.params.id), role);
    if (!updated) return res.status(404).json({ error: "User not found" });
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Failed to update role" });
  }
});

app.delete("/auth/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === Number(req.dbUser.id)) {
    return res.status(400).json({ error: "Cannot delete your own account" });
  }
  try {
    const deleted = await deleteUser(targetId);
    if (!deleted) return res.status(404).json({ error: "User not found" });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// ── OIDC Identity Provider (for ActualBudget instances) ────────
app.use("/auth/oidc", oidcRouter);

// ── Actual Budget deployment proxy (to finance-api) ────────────

async function financeRequest(method, userId, body) {
  if (!config.financeApiUrl) return { status: "not_configured" };
  const url = `${config.financeApiUrl}/deployments/${userId}`;
  console.log(`[finance-proxy] ${method} ${url}`);
  const opts = {
    method,
    headers: { "X-Api-Key": config.financeApiKey, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) {
    console.error(`[finance-proxy] ${method} ${url} → ${res.status}`, data);
    throw new Error(data.message || data.error || `Finance API ${res.status}`);
  }
  return data;
}

app.get("/auth/deployments/actualbudget", requireAuth, async (req, res) => {
  try {
    const result = await financeRequest("GET", req.dbUser.id);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: "Finance service unavailable" });
  }
});

app.post("/auth/deployments/actualbudget", requireAuth, async (req, res) => {
  try {
    const email = req.dbUser.email || "";
    const username = email.split("@")[0] || `user${req.dbUser.id}`;
    const result = await financeRequest("POST", req.dbUser.id, { username });
    res.status(201).json(result);
  } catch (err) {
    res.status(502).json({ error: "Finance service unavailable" });
  }
});

app.put("/auth/deployments/actualbudget", requireAuth, async (req, res) => {
  try {
    const result = await financeRequest("PUT", req.dbUser.id);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: "Finance service unavailable" });
  }
});

app.delete("/auth/deployments/actualbudget", requireAuth, async (req, res) => {
  try {
    const result = await financeRequest("DELETE", req.dbUser.id);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: "Finance service unavailable" });
  }
});

export default app;

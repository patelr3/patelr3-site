import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import config from "./config.js";
import {
  upsertGoogleUser, findUserByEmail, createLocalUser,
  listServices, getServiceBySlug, updateService,
  getUserAccess, grantAccess,
  createAccessRequest, listAccessRequests, updateAccessRequest, getUserPendingRequests,
  findUserById, listUsers, updateUserRole, updateUserPassword, touchLastLogin, deleteUser,
  createResetToken, findResetToken, deleteResetToken,
} from "./db.js";

const app = express();
app.use(express.json());
app.use(cookieParser());

// CORS — allow frontend origin for cross-origin API calls in production
const allowedOrigins = [config.frontendUrl];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(
  session({
    secret: config.jwtSecret,
    resave: false,
    saveUninitialized: false,
  })
);
app.use(passport.initialize());
app.use(passport.session());

function issueJwtCookie(res, user) {
  const payload = {
    sub: String(user.id),
    email: user.email,
    name: user.display_name,
    role: user.role,
  };
  const token = jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
  res.cookie("access_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.frontendUrl.startsWith("https"),
    maxAge: 24 * 60 * 60 * 1000,
    path: "/",
  });
  return token;
}

// ── Passport Google OAuth ──────────────────────────────────────

passport.use(
  new GoogleStrategy(
    {
      clientID: config.googleClientId,
      clientSecret: config.googleClientSecret,
      callbackURL: `${config.frontendUrl}/api/auth/callback/google`,
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const user = await upsertGoogleUser(profile);
        done(null, user);
      } catch (err) {
        done(err);
      }
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ── Google OAuth routes ────────────────────────────────────────

app.get(
  "/auth/login/google",
  passport.authenticate("google", { scope: ["openid", "email", "profile"] })
);

app.get(
  "/auth/callback/google",
  passport.authenticate("google", { failureRedirect: config.frontendUrl }),
  (req, res) => {
    issueJwtCookie(res, req.user);
    touchLastLogin(req.user.id).catch(() => {});
    res.redirect(config.frontendUrl);
  }
);

// ── Email/password routes ──────────────────────────────────────

app.post("/auth/register", async (req, res) => {
  const { email, password, displayName } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    return res.status(409).json({ error: "An account with this email already exists" });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const user = await createLocalUser(email, hash, displayName || email.split("@")[0]);
    issueJwtCookie(res, user);
    touchLastLogin(user.id).catch(() => {});
    res.status(201).json({ authenticated: true, email: user.email, name: user.display_name, role: user.role });
  } catch (err) {
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const user = await findUserByEmail(email);
  if (!user || !user.password_hash) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  issueJwtCookie(res, user);
  touchLastLogin(user.id).catch(() => {});
  res.json({ authenticated: true, email: user.email, name: user.display_name, role: user.role });
});

// ── Current user / verify / logout ─────────────────────────────

app.get("/auth/me", (req, res) => {
  const token = req.cookies.access_token;
  if (!token) return res.status(401).json({ authenticated: false });

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    res.json({
      authenticated: true,
      email: payload.email,
      name: payload.name,
      role: payload.role,
    });
  } catch {
    res.status(401).json({ authenticated: false });
  }
});

app.get("/auth/verify", (req, res) => {
  const token = req.cookies.access_token;
  if (!token) return res.sendStatus(401);

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    res.set("X-Auth-User", payload.email || "");
    res.set("X-Auth-Role", payload.role || "");
    res.sendStatus(200);
  } catch {
    res.sendStatus(401);
  }
});

app.get("/auth/logout", (_req, res) => {
  res.clearCookie("access_token", {
    path: "/",
    sameSite: "lax",
    secure: config.frontendUrl.startsWith("https"),
  });
  res.redirect(config.frontendUrl);
});

// ── JWT auth middleware ─────────────────────────────────────────

function requireAuth(req, res, next) {
  const token = req.cookies.access_token;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    req.jwtUser = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

function requireAdmin(req, res, next) {
  if (req.jwtUser?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// ── Service endpoints ──────────────────────────────────────────

app.get("/auth/services", requireAuth, async (req, res) => {
  try {
    const services = await listServices();
    const isAdmin = req.jwtUser.role === "admin";
    const userId = Number(req.jwtUser.sub);
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
    const request = await createAccessRequest(Number(req.jwtUser.sub), serviceId);
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
    const ar = await updateAccessRequest(Number(req.params.id), "approved", Number(req.jwtUser.sub));
    if (!ar) return res.status(404).json({ error: "Request not found" });
    await grantAccess(ar.user_id, ar.service_id);
    res.json(ar);
  } catch (err) {
    res.status(500).json({ error: "Failed to approve request" });
  }
});

app.post("/auth/access-requests/:id/deny", requireAuth, requireAdmin, async (req, res) => {
  try {
    const ar = await updateAccessRequest(Number(req.params.id), "denied", Number(req.jwtUser.sub));
    if (!ar) return res.status(404).json({ error: "Request not found" });
    res.json(ar);
  } catch (err) {
    res.status(500).json({ error: "Failed to deny request" });
  }
});

// ── Account endpoints ───────────────────────────────────────────

app.get("/auth/account", requireAuth, async (req, res) => {
  try {
    const user = await findUserById(Number(req.jwtUser.sub));
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      hasPassword: !!user.password_hash,
      isGoogleUser: !!user.google_id,
      createdAt: user.created_at,
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch account" });
  }
});

app.post("/auth/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters" });
  }
  try {
    const user = await findUserById(Number(req.jwtUser.sub));
    if (!user) return res.status(404).json({ error: "User not found" });

    // If user has an existing password, verify it
    if (user.password_hash) {
      if (!currentPassword) {
        return res.status(400).json({ error: "Current password is required" });
      }
      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) return res.status(401).json({ error: "Current password is incorrect" });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await updateUserPassword(user.id, hash);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to change password" });
  }
});

// ── Password reset (token-based, no email sending) ─────────────

app.post("/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required" });

  const user = await findUserByEmail(email);
  // Always return success to avoid leaking user existence
  if (!user) return res.json({ success: true });

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await createResetToken(user.id, token, expiresAt);

  // In production you'd email this link. For now, log and return it.
  const resetUrl = `${config.frontendUrl}/reset-password?token=${token}`;
  console.log(`Password reset link for ${email}: ${resetUrl}`);
  res.json({ success: true, resetUrl });
});

app.post("/auth/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ error: "Token and new password are required" });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const resetToken = await findResetToken(token);
  if (!resetToken) return res.status(400).json({ error: "Invalid or expired reset token" });

  const hash = await bcrypt.hash(newPassword, 12);
  await updateUserPassword(resetToken.user_id, hash);
  await deleteResetToken(token);
  res.json({ success: true });
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
  if (targetId === Number(req.jwtUser.sub)) {
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
    const result = await financeRequest("GET", req.jwtUser.sub);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: "Finance service unavailable" });
  }
});

app.post("/auth/deployments/actualbudget", requireAuth, async (req, res) => {
  try {
    const email = req.jwtUser.email || "";
    const username = email.split("@")[0] || `user${req.jwtUser.sub}`;
    const result = await financeRequest("POST", req.jwtUser.sub, { username });
    res.status(201).json(result);
  } catch (err) {
    res.status(502).json({ error: "Finance service unavailable" });
  }
});

app.put("/auth/deployments/actualbudget", requireAuth, async (req, res) => {
  try {
    const result = await financeRequest("PUT", req.jwtUser.sub);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: "Finance service unavailable" });
  }
});

app.delete("/auth/deployments/actualbudget", requireAuth, async (req, res) => {
  try {
    const result = await financeRequest("DELETE", req.jwtUser.sub);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: "Finance service unavailable" });
  }
});

export default app;

import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "change-me";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost";

const app = express();
app.use(cookieParser());

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && origin === FRONTEND_URL) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => {
  let user = req.headers["x-auth-user"] || "stranger";
  let role = req.headers["x-auth-role"] || "unknown";

  const token = req.cookies?.access_token;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      user = payload.email || user;
      role = payload.role || role;
    } catch { /* use header values */ }
  }

  res.json({
    message: `🔒 Welcome to the restricted zone, ${user}!`,
    role,
    service: "hello-world-restricted",
    secret: "You have been granted special access.",
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

export default app;

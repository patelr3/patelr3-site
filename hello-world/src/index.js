import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";

const app = express();
const PORT = 5000;
const JWT_SECRET = process.env.JWT_SECRET || "change-me";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost";

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
  // Try JWT from cookie (ACA direct), fall back to proxy headers (local Nginx)
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
    message: `Hello, ${user}!`,
    role,
    service: "hello-world",
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`hello-world listening on :${PORT}`);
});

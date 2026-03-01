import express from "express";
import cookieParser from "cookie-parser";
import { createRemoteJWKSet, jwtVerify } from "jose";

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "";
const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const JWKS = createRemoteJWKSet(new URL(GOOGLE_CERTS_URL));
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost";

async function verifyFirebaseToken(token) {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
    audience: FIREBASE_PROJECT_ID,
  });
  return payload;
}

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

app.get("/", async (req, res) => {
  let user = req.headers["x-auth-user"] || "stranger";
  let role = req.headers["x-auth-role"] || "unknown";

  const token = req.cookies?.access_token || req.headers.authorization?.replace("Bearer ", "");
  if (token) {
    try {
      const payload = await verifyFirebaseToken(token);
      user = payload.email || user;
      role = "user";
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

export default app;

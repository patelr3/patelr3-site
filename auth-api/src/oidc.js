// OIDC Identity Provider — wraps Google OAuth so ActualBudget instances
// can use auth-api as their OpenID provider with a single redirect URI.
import { Router } from "express";
import crypto from "crypto";
import { importPKCS8, exportJWK, SignJWT, generateKeyPair } from "jose";
import config from "./config.js";
import { storeOidcAuthCode, consumeOidcAuthCode, findUserById } from "./db.js";

const router = Router();

// ── RSA key pair for signing ID tokens ────────────────────────
let signingKey = null;   // CryptoKey (private)
let publicJwk = null;    // JWK (public)
const KID = "oidc-signing-key-1";

async function ensureKeys() {
  if (signingKey) return;
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  publicJwk = { ...jwk, kid: KID, alg: "RS256", use: "sig" };
}

function issuerUrl() {
  const base = config.authApiUrl || config.frontendUrl;
  return `${base}/api/auth/oidc`;
}

// ── Discovery document ────────────────────────────────────────
router.get("/.well-known/openid-configuration", async (_req, res) => {
  const iss = issuerUrl();
  res.json({
    issuer: iss,
    authorization_endpoint: `${iss}/authorize`,
    token_endpoint: `${iss}/token`,
    userinfo_endpoint: `${iss}/userinfo`,
    jwks_uri: `${iss}/jwks`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "email", "profile"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    claims_supported: ["sub", "email", "name", "preferred_username"],
    code_challenge_methods_supported: ["S256", "plain"],
    grant_types_supported: ["authorization_code"],
  });
});

// ── JWKS endpoint ─────────────────────────────────────────────
router.get("/jwks", async (_req, res) => {
  await ensureKeys();
  res.json({ keys: [publicJwk] });
});

// ── Authorize endpoint ────────────────────────────────────────
// ActualBudget redirects users here. We redirect to Google OAuth,
// storing AB's callback info in the session state.
router.get("/authorize", (req, res) => {
  const {
    redirect_uri, state, client_id, response_type,
    code_challenge, code_challenge_method, scope,
  } = req.query;

  if (response_type !== "code") {
    return res.status(400).json({ error: "unsupported_response_type" });
  }
  if (client_id !== config.oidcClientId) {
    return res.status(400).json({ error: "invalid_client" });
  }
  if (!redirect_uri) {
    return res.status(400).json({ error: "invalid_request", error_description: "redirect_uri is required" });
  }

  // Store AB's request parameters in session so we can resume after Google OAuth
  const oidcState = crypto.randomBytes(16).toString("hex");
  req.session.oidcPending = {
    redirectUri: redirect_uri,
    state: state || "",
    clientId: client_id,
    codeChallenge: code_challenge || "",
    codeChallengeMethod: code_challenge_method || "",
    scope: scope || "openid",
    oidcState,
  };

  // Redirect to Google OAuth — reuse existing passport strategy
  const googleAuthUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  googleAuthUrl.searchParams.set("client_id", config.googleClientId);
  googleAuthUrl.searchParams.set("redirect_uri", `${config.frontendUrl}/api/auth/oidc/callback`);
  googleAuthUrl.searchParams.set("response_type", "code");
  googleAuthUrl.searchParams.set("scope", "openid email profile");
  googleAuthUrl.searchParams.set("state", oidcState);
  googleAuthUrl.searchParams.set("access_type", "online");
  googleAuthUrl.searchParams.set("prompt", "select_account");

  res.redirect(googleAuthUrl.toString());
});

// ── OAuth callback from Google ────────────────────────────────
// Exchanges Google's code for user info, then creates an auth code
// for the ActualBudget instance and redirects back to it.
router.get("/callback", async (req, res) => {
  const { code, state } = req.query;
  const pending = req.session.oidcPending;

  if (!pending || pending.oidcState !== state) {
    return res.status(400).json({ error: "invalid_state" });
  }

  try {
    // Exchange Google auth code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: `${config.frontendUrl}/api/auth/oidc/callback`,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("[oidc] Google token exchange failed:", err);
      return res.status(502).json({ error: "google_token_exchange_failed" });
    }

    const tokens = await tokenRes.json();

    // Get user info from Google
    const userinfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userinfo = await userinfoRes.json();

    // Upsert user in our database (reuse existing logic)
    const { upsertGoogleUser } = await import("./db.js");
    const user = await upsertGoogleUser({
      id: userinfo.sub,
      displayName: userinfo.name,
      emails: [{ value: userinfo.email }],
      photos: [{ value: userinfo.picture }],
    });

    // Generate authorization code for ActualBudget
    const authCode = crypto.randomBytes(32).toString("hex");
    const googleClaims = {
      sub: userinfo.sub,
      email: userinfo.email,
      name: userinfo.name,
      preferred_username: userinfo.email,
      picture: userinfo.picture,
    };

    await storeOidcAuthCode(
      authCode, user.id, pending.redirectUri, pending.clientId,
      pending.codeChallenge, pending.codeChallengeMethod, googleClaims,
    );

    // Clean up session
    delete req.session.oidcPending;

    // Redirect back to ActualBudget's /openid/callback
    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set("code", authCode);
    if (pending.state) redirectUrl.searchParams.set("state", pending.state);
    res.redirect(redirectUrl.toString());
  } catch (err) {
    console.error("[oidc] Callback error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Token endpoint ────────────────────────────────────────────
// ActualBudget exchanges the authorization code for ID + access tokens.
router.post("/token", async (req, res) => {
  await ensureKeys();

  const { code, grant_type, redirect_uri, client_id, client_secret, code_verifier } = req.body;

  if (grant_type !== "authorization_code") {
    return res.status(400).json({ error: "unsupported_grant_type" });
  }

  // Validate client credentials (from body or Basic auth header)
  let reqClientId = client_id;
  let reqClientSecret = client_secret;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
    const [id, secret] = decoded.split(":");
    reqClientId = reqClientId || id;
    reqClientSecret = reqClientSecret || secret;
  }

  if (reqClientId !== config.oidcClientId || reqClientSecret !== config.oidcClientSecret) {
    return res.status(401).json({ error: "invalid_client" });
  }

  // Consume the authorization code (single-use)
  const authCode = await consumeOidcAuthCode(code);
  if (!authCode) {
    return res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired authorization code" });
  }

  // Verify redirect_uri matches
  if (redirect_uri && redirect_uri !== authCode.redirect_uri) {
    return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
  }

  // Verify PKCE code_verifier if code_challenge was provided
  if (authCode.code_challenge) {
    if (!code_verifier) {
      return res.status(400).json({ error: "invalid_grant", error_description: "code_verifier required" });
    }
    const method = authCode.code_challenge_method || "plain";
    let computed;
    if (method === "S256") {
      computed = crypto.createHash("sha256").update(code_verifier).digest("base64url");
    } else {
      computed = code_verifier;
    }
    if (computed !== authCode.code_challenge) {
      return res.status(400).json({ error: "invalid_grant", error_description: "code_verifier mismatch" });
    }
  }

  const claims = typeof authCode.google_claims === "string"
    ? JSON.parse(authCode.google_claims)
    : authCode.google_claims;

  const iss = issuerUrl();
  const now = Math.floor(Date.now() / 1000);

  // Sign ID token
  const idToken = await new SignJWT({
    email: claims.email,
    name: claims.name,
    preferred_username: claims.preferred_username || claims.email,
    picture: claims.picture,
  })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(iss)
    .setSubject(String(authCode.user_id))
    .setAudience(config.oidcClientId)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(signingKey);

  // Generate opaque access token (used for userinfo)
  const accessToken = crypto.randomBytes(32).toString("hex");

  // Store access token → user mapping in memory (short-lived)
  accessTokenStore.set(accessToken, { userId: authCode.user_id, claims, expiresAt: Date.now() + 3600 * 1000 });

  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    id_token: idToken,
  });
});

// In-memory store for access tokens (short-lived, ok for single-instance)
const accessTokenStore = new Map();

// Periodic cleanup of expired access tokens
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of accessTokenStore) {
    if (data.expiresAt < now) accessTokenStore.delete(token);
  }
}, 60 * 1000);

// ── Userinfo endpoint ─────────────────────────────────────────
router.get("/userinfo", (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "invalid_token" });
  }

  const token = auth.slice(7);
  const data = accessTokenStore.get(token);
  if (!data || data.expiresAt < Date.now()) {
    return res.status(401).json({ error: "invalid_token" });
  }

  res.json({
    sub: String(data.userId),
    email: data.claims.email,
    name: data.claims.name,
    preferred_username: data.claims.preferred_username || data.claims.email,
    picture: data.claims.picture,
  });
});

// Export for testing
export { accessTokenStore, ensureKeys };
export default router;

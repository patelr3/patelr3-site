// OIDC Identity Provider — wraps Google OAuth so ActualBudget instances
// can use auth-api as their OpenID provider with a single redirect URI.
import { Router } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { exportJWK, importJWK, SignJWT, generateKeyPair } from "jose";
import config from "./config.js";
import logger from "./logger.js";
import {
  storeOidcAuthCode, consumeOidcAuthCode, findUserById,
  storeOidcAccessToken, getOidcAccessToken, deleteExpiredOidcTokens,
  storeOidcRefreshToken, consumeOidcRefreshToken,
} from "./db.js";

const router = Router();

// ── RSA key pair for signing ID tokens ────────────────────────
let signingKey = null;   // CryptoKey (private)
let publicJwk = null;    // JWK (public)
const KID = "oidc-signing-key-1";

async function ensureKeys() {
  if (signingKey) return;

  if (config.oidcSigningKeyJwk) {
    // Persistent key from AKV — survives restarts/deployments
    const privateJwk = JSON.parse(config.oidcSigningKeyJwk);
    signingKey = await importJWK(privateJwk, "RS256");
    // Derive public JWK by stripping private fields
    const { d, p, q, dp, dq, qi, ...pub } = privateJwk;
    publicJwk = { ...pub, kid: KID, alg: "RS256", use: "sig" };
    logger.info("OIDC signing key loaded from AKV");
  } else {
    // Ephemeral key for local dev
    const pair = await generateKeyPair("RS256");
    signingKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    publicJwk = { ...jwk, kid: KID, alg: "RS256", use: "sig" };
    logger.info("OIDC signing key generated (ephemeral — local dev)");
  }
}

function issuerUrl() {
  const base = config.authApiUrl || config.frontendUrl;
  return `${base}/api/auth/oidc`;
}

// ── Client validation helpers ─────────────────────────────────

function isValidClient(clientId) {
  return !!(config.oidcClients[clientId]);
}

function isValidClientCredentials(clientId, clientSecret) {
  const client = config.oidcClients[clientId];
  return client && client.secret === clientSecret;
}

// ── Discovery document ────────────────────────────────────────
router.get("/.well-known/openid-configuration", async (_req, res) => {
  const iss = issuerUrl();
  logger.info("OIDC discovery requested", { issuer: iss });
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
    grant_types_supported: ["authorization_code", "refresh_token"],
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
// If the user already has a valid access_token cookie, skip Google.
router.get("/authorize", async (req, res) => {
  const {
    redirect_uri, state, client_id, response_type,
    code_challenge, code_challenge_method, scope,
  } = req.query;

  logger.info("OIDC authorize request", {
    clientId: client_id, redirectUri: redirect_uri, scope,
    hasCookie: !!req.cookies?.access_token, responseType: response_type,
  });

  if (response_type !== "code") {
    return res.status(400).json({ error: "unsupported_response_type" });
  }
  if (!isValidClient(client_id)) {
    return res.status(400).json({ error: "invalid_client" });
  }
  if (!redirect_uri) {
    return res.status(400).json({ error: "invalid_request", error_description: "redirect_uri is required" });
  }

  // Skip Google redirect if user already has a valid access_token cookie
  const accessTokenCookie = req.cookies?.access_token;
  if (accessTokenCookie) {
    try {
      const payload = jwt.verify(accessTokenCookie, config.jwtSecret);
      const user = await findUserById(Number(payload.sub));
      if (user) {
        // Generate auth code directly — skip Google OAuth
        const authCode = crypto.randomBytes(32).toString("hex");
        const googleClaims = {
          sub: user.google_id || String(user.id),
          email: user.email,
          name: user.display_name,
          preferred_username: user.email,
          picture: user.avatar_url || "",
        };

        await storeOidcAuthCode(
          authCode, user.id, redirect_uri, client_id,
          code_challenge || "", code_challenge_method || "", googleClaims,
        );

        logger.info("OIDC authorize: skipped Google for authenticated user", { userId: user.id, clientId: client_id });

        const redirectUrl = new URL(redirect_uri);
        redirectUrl.searchParams.set("code", authCode);
        if (state) redirectUrl.searchParams.set("state", state);
        return res.redirect(redirectUrl.toString());
      }
    } catch {
      // Cookie invalid or user not found — fall through to Google OAuth
    }
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
      logger.error("OIDC Google token exchange failed", { error: err });
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
    logger.error("OIDC callback error", { error: err.message });
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Token endpoint ────────────────────────────────────────────
router.post("/token", async (req, res) => {
  await ensureKeys();

  const { grant_type } = req.body;

  // Extract client credentials from body or Basic auth header
  let reqClientId = req.body.client_id;
  let reqClientSecret = req.body.client_secret;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
    const [id, secret] = decoded.split(":");
    reqClientId = reqClientId || id;
    reqClientSecret = reqClientSecret || secret;
  }

  logger.info("OIDC token request", {
    grantType: grant_type, clientId: reqClientId,
    hasCode: !!req.body.code, hasRefreshToken: !!req.body.refresh_token,
    hasBasicAuth: !!authHeader?.startsWith("Basic "),
  });

  if (grant_type === "authorization_code") {
    return handleAuthorizationCodeGrant(req, res, reqClientId, reqClientSecret);
  }
  if (grant_type === "refresh_token") {
    return handleRefreshTokenGrant(req, res, reqClientId, reqClientSecret);
  }

  return res.status(400).json({ error: "unsupported_grant_type" });
});

async function handleAuthorizationCodeGrant(req, res, reqClientId, reqClientSecret) {
  const { code, redirect_uri, code_verifier } = req.body;

  if (!isValidClientCredentials(reqClientId, reqClientSecret)) {
    logger.warn("OIDC token: invalid client credentials", { clientId: reqClientId });
    return res.status(401).json({ error: "invalid_client" });
  }

  // Consume the authorization code (single-use)
  const authCode = await consumeOidcAuthCode(code);
  if (!authCode) {
    logger.warn("OIDC token: invalid auth code", { clientId: reqClientId, codePrefix: code?.slice(0, 8) });
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

  const tokenResponse = await issueTokens(authCode.user_id, reqClientId, claims);
  logger.info("OIDC token issued (auth_code)", { userId: authCode.user_id, clientId: reqClientId });
  res.json(tokenResponse);
}

async function handleRefreshTokenGrant(req, res, reqClientId, reqClientSecret) {
  const { refresh_token } = req.body;

  if (!isValidClientCredentials(reqClientId, reqClientSecret)) {
    logger.warn("OIDC refresh: invalid client credentials", { clientId: reqClientId });
    return res.status(401).json({ error: "invalid_client" });
  }

  if (!refresh_token) {
    logger.warn("OIDC refresh: missing refresh_token", { clientId: reqClientId });
    return res.status(400).json({ error: "invalid_grant", error_description: "refresh_token is required" });
  }

  // Consume refresh token (single-use, rotating)
  const storedToken = await consumeOidcRefreshToken(refresh_token);
  if (!storedToken) {
    logger.warn("OIDC refresh: invalid or expired refresh token", { clientId: reqClientId, tokenPrefix: refresh_token?.slice(0, 8) });
    return res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired refresh token" });
  }

  // Verify client_id matches the one the refresh token was issued to
  if (storedToken.client_id !== reqClientId) {
    logger.warn("OIDC refresh: client_id mismatch", { expected: storedToken.client_id, got: reqClientId });
    return res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch" });
  }

  // Look up user to get current claims
  const user = await findUserById(storedToken.user_id);
  if (!user) {
    return res.status(400).json({ error: "invalid_grant", error_description: "User not found" });
  }

  const claims = {
    sub: user.google_id || String(user.id),
    email: user.email,
    name: user.display_name,
    preferred_username: user.email,
    picture: user.avatar_url || "",
  };

  logger.info("OIDC token issued (refresh)", { userId: user.id, clientId: reqClientId });

  const tokenResponse = await issueTokens(storedToken.user_id, reqClientId, claims);
  res.json(tokenResponse);
}

async function issueTokens(userId, clientId, claims) {
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
    .setSubject(String(userId))
    .setAudience(clientId)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(signingKey);

  // Issue access token as RS256 JWT so downstream services (e.g. MCP server)
  // can validate it via JWKS without calling back to the IdP.
  const accessToken = await new SignJWT({
    email: claims.email,
    name: claims.name,
    preferred_username: claims.preferred_username || claims.email,
    role: "user",
  })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(iss)
    .setSubject(String(userId))
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(signingKey);

  const accessExpiresAt = new Date(Date.now() + 3600 * 1000);
  await storeOidcAccessToken(accessToken, userId, claims, accessExpiresAt);

  // Generate refresh token (64-byte hex, 30-day expiry)
  const refreshToken = crypto.randomBytes(64).toString("hex");
  const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  await storeOidcRefreshToken(refreshToken, userId, clientId, refreshExpiresAt);

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    id_token: idToken,
    refresh_token: refreshToken,
  };
}

// ── Userinfo endpoint ─────────────────────────────────────────
router.get("/userinfo", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    logger.warn("OIDC userinfo: missing bearer token");
    return res.status(401).json({ error: "invalid_token" });
  }

  const token = auth.slice(7);
  const data = await getOidcAccessToken(token);
  if (!data) {
    logger.warn("OIDC userinfo: token not found in store");
    return res.status(401).json({ error: "invalid_token" });
  }

  logger.info("OIDC userinfo served", { userId: data.user_id });

  const claims = typeof data.claims === "string" ? JSON.parse(data.claims) : data.claims;

  res.json({
    sub: String(data.user_id),
    email: claims.email,
    name: claims.name,
    preferred_username: claims.preferred_username || claims.email,
    picture: claims.picture,
  });
});

// Clean up expired OIDC tokens on startup and periodically
deleteExpiredOidcTokens().catch(() => {});
setInterval(() => deleteExpiredOidcTokens().catch(() => {}), 60 * 60 * 1000);

// Export for testing
export { ensureKeys };
export default router;

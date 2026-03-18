import { jest } from "@jest/globals";

// Mock DB module BEFORE importing app
const mockDb = {
  initDb: jest.fn(),
  findUserByEmail: jest.fn(),
  upsertFirebaseUser: jest.fn(),
  listServices: jest.fn(),
  getServiceBySlug: jest.fn(),
  updateService: jest.fn(),
  getUserAccess: jest.fn(),
  grantAccess: jest.fn(),
  revokeAccess: jest.fn(),
  createAccessRequest: jest.fn(),
  listAccessRequests: jest.fn(),
  updateAccessRequest: jest.fn(),
  getUserPendingRequests: jest.fn(),
  findUserById: jest.fn(),
  listUsers: jest.fn(),
  updateUserRole: jest.fn(),
  touchLastLogin: jest.fn(),
  deleteUser: jest.fn(),
  storeOidcAuthCode: jest.fn(),
  consumeOidcAuthCode: jest.fn(),
  storeOidcAccessToken: jest.fn(),
  getOidcAccessToken: jest.fn(),
  deleteExpiredOidcTokens: jest.fn().mockResolvedValue(),
  storeOidcRefreshToken: jest.fn(),
  consumeOidcRefreshToken: jest.fn(),
};

jest.unstable_mockModule("../src/db.js", () => mockDb);

// Mock tracing (imported by chat.js)
jest.unstable_mockModule("../src/tracing.js", () => ({
  trace: { getTracer: () => ({ startSpan: () => ({ setStatus: jest.fn(), end: jest.fn(), spanContext: () => ({ traceId: "t" }) }), startActiveSpan: jest.fn((_n, _o, fn) => fn({ setStatus: jest.fn(), addEvent: jest.fn(), end: jest.fn(), spanContext: () => ({ traceId: "t" }) })) }) },
  context: {},
  SpanStatusCode: { OK: 1, ERROR: 2 },
}));

// Mock @azure/ai-projects and @azure/identity (imported by chat.js)
jest.unstable_mockModule("@azure/ai-projects", () => ({
  AIProjectClient: jest.fn().mockImplementation(() => ({
    getOpenAIClient: jest.fn(() => ({ conversations: { create: jest.fn() }, responses: { create: jest.fn() } })),
  })),
}));
jest.unstable_mockModule("@azure/identity", () => ({ DefaultAzureCredential: jest.fn() }));

// Mock firebase-admin/app and firebase-admin/auth
jest.unstable_mockModule("firebase-admin/app", () => ({
  initializeApp: jest.fn(),
}));

const mockVerifyIdToken = jest.fn();
jest.unstable_mockModule("firebase-admin/auth", () => ({
  getAuth: jest.fn(() => ({
    verifyIdToken: mockVerifyIdToken,
  })),
}));

const { default: app } = await import("../src/app.js");
import request from "supertest";
import crypto from "crypto";

const OIDC_CLIENT_ID = "actualbudget";
const OIDC_CLIENT_SECRET = "change-me";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("OIDC Discovery", () => {
  it("returns valid openid-configuration", async () => {
    const res = await request(app)
      .get("/auth/oidc/.well-known/openid-configuration")
      .expect(200);

    expect(res.body.issuer).toContain("/api/auth/oidc");
    expect(res.body.authorization_endpoint).toContain("/authorize");
    expect(res.body.token_endpoint).toContain("/token");
    expect(res.body.userinfo_endpoint).toContain("/userinfo");
    expect(res.body.jwks_uri).toContain("/jwks");
    expect(res.body.response_types_supported).toContain("code");
    expect(res.body.id_token_signing_alg_values_supported).toContain("RS256");
    expect(res.body.scopes_supported).toEqual(expect.arrayContaining(["openid", "email", "profile"]));
    expect(res.body.code_challenge_methods_supported).toEqual(expect.arrayContaining(["S256", "plain"]));
    expect(res.body.grant_types_supported).toContain("authorization_code");
    expect(res.body.grant_types_supported).toContain("refresh_token");
  });
});

describe("OIDC JWKS", () => {
  it("returns a valid JWKS with RSA key", async () => {
    const res = await request(app)
      .get("/auth/oidc/jwks")
      .expect(200);

    expect(res.body.keys).toBeInstanceOf(Array);
    expect(res.body.keys.length).toBe(1);

    const key = res.body.keys[0];
    expect(key.kty).toBe("RSA");
    expect(key.alg).toBe("RS256");
    expect(key.use).toBe("sig");
    expect(key.kid).toBe("oidc-signing-key-1");
    expect(key.n).toBeDefined();
    expect(key.e).toBeDefined();
  });

  it("returns same key on subsequent calls", async () => {
    const res1 = await request(app).get("/auth/oidc/jwks").expect(200);
    const res2 = await request(app).get("/auth/oidc/jwks").expect(200);
    expect(res1.body.keys[0].n).toBe(res2.body.keys[0].n);
  });
});

describe("OIDC Authorize", () => {
  it("rejects unsupported response_type", async () => {
    const res = await request(app)
      .get("/auth/oidc/authorize")
      .query({ response_type: "token", client_id: OIDC_CLIENT_ID, redirect_uri: "https://example.com/cb" })
      .expect(400);

    expect(res.body.error).toBe("unsupported_response_type");
  });

  it("rejects invalid client_id", async () => {
    const res = await request(app)
      .get("/auth/oidc/authorize")
      .query({ response_type: "code", client_id: "wrong", redirect_uri: "https://example.com/cb" })
      .expect(400);

    expect(res.body.error).toBe("invalid_client");
  });

  it("rejects missing redirect_uri", async () => {
    const res = await request(app)
      .get("/auth/oidc/authorize")
      .query({ response_type: "code", client_id: OIDC_CLIENT_ID })
      .expect(400);

    expect(res.body.error).toBe("invalid_request");
  });

  it("redirects to Google OAuth with valid params", async () => {
    const res = await request(app)
      .get("/auth/oidc/authorize")
      .query({
        response_type: "code",
        client_id: OIDC_CLIENT_ID,
        redirect_uri: "https://ab-instance.example.com/openid/callback",
        state: "ab-state-123",
        scope: "openid email profile",
      })
      .expect(302);

    expect(res.headers.location).toContain("accounts.google.com");
    expect(res.headers.location).toContain("scope=openid");
    expect(res.headers.location).toContain("response_type=code");
  });
});

describe("OIDC Token", () => {
  it("rejects unsupported grant_type", async () => {
    const res = await request(app)
      .post("/auth/oidc/token")
      .send({ grant_type: "implicit", code: "test" })
      .expect(400);

    expect(res.body.error).toBe("unsupported_grant_type");
  });

  it("rejects invalid client credentials", async () => {
    const res = await request(app)
      .post("/auth/oidc/token")
      .send({
        grant_type: "authorization_code",
        code: "test",
        client_id: "wrong",
        client_secret: "wrong",
      })
      .expect(401);

    expect(res.body.error).toBe("invalid_client");
  });

  it("rejects invalid/expired authorization code", async () => {
    mockDb.consumeOidcAuthCode.mockResolvedValue(null);

    const res = await request(app)
      .post("/auth/oidc/token")
      .send({
        grant_type: "authorization_code",
        code: "invalid-code",
        client_id: OIDC_CLIENT_ID,
        client_secret: OIDC_CLIENT_SECRET,
      })
      .expect(400);

    expect(res.body.error).toBe("invalid_grant");
  });

  it("rejects redirect_uri mismatch", async () => {
    mockDb.consumeOidcAuthCode.mockResolvedValue({
      code: "valid-code",
      user_id: 1,
      redirect_uri: "https://correct.example.com/cb",
      client_id: OIDC_CLIENT_ID,
      google_claims: { email: "test@test.com", name: "Test", sub: "g123" },
    });

    const res = await request(app)
      .post("/auth/oidc/token")
      .send({
        grant_type: "authorization_code",
        code: "valid-code",
        client_id: OIDC_CLIENT_ID,
        client_secret: OIDC_CLIENT_SECRET,
        redirect_uri: "https://wrong.example.com/cb",
      })
      .expect(400);

    expect(res.body.error).toBe("invalid_grant");
    expect(res.body.error_description).toContain("redirect_uri");
  });

  it("exchanges valid code for tokens", async () => {
    mockDb.consumeOidcAuthCode.mockResolvedValue({
      code: "valid-code",
      user_id: 42,
      redirect_uri: "https://ab.example.com/openid/callback",
      client_id: OIDC_CLIENT_ID,
      google_claims: {
        email: "test@test.com",
        name: "Test User",
        preferred_username: "test@test.com",
        sub: "google-sub-123",
        picture: "https://example.com/photo.jpg",
      },
    });

    const res = await request(app)
      .post("/auth/oidc/token")
      .send({
        grant_type: "authorization_code",
        code: "valid-code",
        client_id: OIDC_CLIENT_ID,
        client_secret: OIDC_CLIENT_SECRET,
        redirect_uri: "https://ab.example.com/openid/callback",
      })
      .expect(200);

    expect(res.body.access_token).toBeDefined();
    expect(res.body.token_type).toBe("Bearer");
    expect(res.body.expires_in).toBe(3600);
    expect(res.body.id_token).toBeDefined();
    expect(res.body.refresh_token).toBeDefined();
    expect(res.body.refresh_token.length).toBe(128); // 64 bytes hex

    // Access token should be a valid RS256 JWT (not opaque)
    const atParts = res.body.access_token.split(".");
    expect(atParts.length).toBe(3);
    const atPayload = JSON.parse(Buffer.from(atParts[1], "base64url").toString());
    expect(atPayload.sub).toBe("42");
    expect(atPayload.email).toBe("test@test.com");
    expect(atPayload.name).toBe("Test User");
    expect(atPayload.role).toBe("user");

    // ID token should be a valid JWT
    const parts = res.body.id_token.split(".");
    expect(parts.length).toBe(3);

    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    expect(payload.sub).toBe("42");
    expect(payload.email).toBe("test@test.com");
    expect(payload.name).toBe("Test User");
    expect(payload.aud).toBe(OIDC_CLIENT_ID);
  });

  it("supports Basic auth header for client credentials", async () => {
    mockDb.consumeOidcAuthCode.mockResolvedValue({
      code: "valid-code",
      user_id: 1,
      redirect_uri: "https://ab.example.com/cb",
      client_id: OIDC_CLIENT_ID,
      google_claims: { email: "test@test.com", name: "Test", sub: "g1" },
    });

    const basicAuth = Buffer.from(`${OIDC_CLIENT_ID}:${OIDC_CLIENT_SECRET}`).toString("base64");

    const res = await request(app)
      .post("/auth/oidc/token")
      .set("Authorization", `Basic ${basicAuth}`)
      .send({ grant_type: "authorization_code", code: "valid-code" })
      .expect(200);

    expect(res.body.access_token).toBeDefined();
    expect(res.body.id_token).toBeDefined();
  });

  it("verifies PKCE code_verifier (S256)", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

    mockDb.consumeOidcAuthCode.mockResolvedValue({
      code: "pkce-code",
      user_id: 1,
      redirect_uri: "https://ab.example.com/cb",
      client_id: OIDC_CLIENT_ID,
      code_challenge: challenge,
      code_challenge_method: "S256",
      google_claims: { email: "test@test.com", name: "Test", sub: "g1" },
    });

    // Valid verifier should succeed
    const res = await request(app)
      .post("/auth/oidc/token")
      .send({
        grant_type: "authorization_code",
        code: "pkce-code",
        client_id: OIDC_CLIENT_ID,
        client_secret: OIDC_CLIENT_SECRET,
        code_verifier: verifier,
      })
      .expect(200);

    expect(res.body.id_token).toBeDefined();
  });

  it("rejects wrong PKCE code_verifier", async () => {
    const verifier = "correct-verifier";
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

    mockDb.consumeOidcAuthCode.mockResolvedValue({
      code: "pkce-code",
      user_id: 1,
      redirect_uri: "https://ab.example.com/cb",
      client_id: OIDC_CLIENT_ID,
      code_challenge: challenge,
      code_challenge_method: "S256",
      google_claims: { email: "test@test.com", name: "Test", sub: "g1" },
    });

    const res = await request(app)
      .post("/auth/oidc/token")
      .send({
        grant_type: "authorization_code",
        code: "pkce-code",
        client_id: OIDC_CLIENT_ID,
        client_secret: OIDC_CLIENT_SECRET,
        code_verifier: "wrong-verifier",
      })
      .expect(400);

    expect(res.body.error).toBe("invalid_grant");
    expect(res.body.error_description).toContain("code_verifier");
  });

  it("requires code_verifier when code_challenge was set", async () => {
    mockDb.consumeOidcAuthCode.mockResolvedValue({
      code: "pkce-code",
      user_id: 1,
      redirect_uri: "https://ab.example.com/cb",
      client_id: OIDC_CLIENT_ID,
      code_challenge: "some-challenge",
      code_challenge_method: "S256",
      google_claims: { email: "test@test.com", name: "Test", sub: "g1" },
    });

    const res = await request(app)
      .post("/auth/oidc/token")
      .send({
        grant_type: "authorization_code",
        code: "pkce-code",
        client_id: OIDC_CLIENT_ID,
        client_secret: OIDC_CLIENT_SECRET,
      })
      .expect(400);

    expect(res.body.error_description).toContain("code_verifier required");
  });
});

describe("OIDC Userinfo", () => {
  it("rejects missing auth header", async () => {
    await request(app)
      .get("/auth/oidc/userinfo")
      .expect(401);
  });

  it("rejects invalid access token", async () => {
    mockDb.getOidcAccessToken.mockResolvedValue(null);

    await request(app)
      .get("/auth/oidc/userinfo")
      .set("Authorization", "Bearer invalid-token")
      .expect(401);
  });

  it("returns user info for valid access token", async () => {
    // First get a valid access token by exchanging a code
    mockDb.consumeOidcAuthCode.mockResolvedValue({
      code: "userinfo-code",
      user_id: 99,
      redirect_uri: "https://ab.example.com/cb",
      client_id: OIDC_CLIENT_ID,
      google_claims: {
        email: "userinfo@test.com",
        name: "Userinfo Test",
        preferred_username: "userinfo@test.com",
        sub: "g-userinfo",
        picture: "https://example.com/avatar.jpg",
      },
    });

    const tokenRes = await request(app)
      .post("/auth/oidc/token")
      .send({
        grant_type: "authorization_code",
        code: "userinfo-code",
        client_id: OIDC_CLIENT_ID,
        client_secret: OIDC_CLIENT_SECRET,
      })
      .expect(200);

    // Mock getOidcAccessToken to return the stored data
    mockDb.getOidcAccessToken.mockResolvedValue({
      token: tokenRes.body.access_token,
      user_id: 99,
      claims: {
        email: "userinfo@test.com",
        name: "Userinfo Test",
        preferred_username: "userinfo@test.com",
        sub: "g-userinfo",
        picture: "https://example.com/avatar.jpg",
      },
      expires_at: new Date(Date.now() + 3600 * 1000),
    });

    const res = await request(app)
      .get("/auth/oidc/userinfo")
      .set("Authorization", `Bearer ${tokenRes.body.access_token}`)
      .expect(200);

    expect(res.body.sub).toBe("99");
    expect(res.body.email).toBe("userinfo@test.com");
    expect(res.body.name).toBe("Userinfo Test");
    expect(res.body.preferred_username).toBe("userinfo@test.com");
    expect(res.body.picture).toBe("https://example.com/avatar.jpg");
  });
});

describe("OIDC Multi-Client Support", () => {
  it("accepts foundry-agent as a valid client_id in authorize", async () => {
    const res = await request(app)
      .get("/auth/oidc/authorize")
      .query({
        response_type: "code",
        client_id: "foundry-agent",
        redirect_uri: "https://foundry.example.com/callback",
        state: "foundry-state",
        scope: "openid email profile",
      })
      .expect(302);

    expect(res.headers.location).toContain("accounts.google.com");
  });

  it("accepts foundry-agent client credentials at token endpoint", async () => {
    mockDb.consumeOidcAuthCode.mockResolvedValue({
      code: "foundry-code",
      user_id: 10,
      redirect_uri: "https://foundry.example.com/callback",
      client_id: "foundry-agent",
      google_claims: { email: "agent@test.com", name: "Agent", sub: "g-agent" },
    });

    const res = await request(app)
      .post("/auth/oidc/token")
      .send({
        grant_type: "authorization_code",
        code: "foundry-code",
        client_id: "foundry-agent",
        client_secret: "change-me",
      })
      .expect(200);

    expect(res.body.access_token).toBeDefined();
    expect(res.body.id_token).toBeDefined();
    expect(res.body.refresh_token).toBeDefined();
  });

  it("rejects unknown client_id in authorize", async () => {
    const res = await request(app)
      .get("/auth/oidc/authorize")
      .query({ response_type: "code", client_id: "unknown-client", redirect_uri: "https://example.com/cb" })
      .expect(400);

    expect(res.body.error).toBe("invalid_client");
  });

  it("rejects unknown client_id at token endpoint", async () => {
    const res = await request(app)
      .post("/auth/oidc/token")
      .send({
        grant_type: "authorization_code",
        code: "test",
        client_id: "unknown-client",
        client_secret: "change-me",
      })
      .expect(401);

    expect(res.body.error).toBe("invalid_client");
  });
});

describe("OIDC Refresh Token Grant", () => {
  it("issues refresh token with authorization_code grant", async () => {
    mockDb.consumeOidcAuthCode.mockResolvedValue({
      code: "refresh-test-code",
      user_id: 5,
      redirect_uri: "https://ab.example.com/cb",
      client_id: OIDC_CLIENT_ID,
      google_claims: { email: "refresh@test.com", name: "Refresh", sub: "g-refresh" },
    });

    const res = await request(app)
      .post("/auth/oidc/token")
      .send({
        grant_type: "authorization_code",
        code: "refresh-test-code",
        client_id: OIDC_CLIENT_ID,
        client_secret: OIDC_CLIENT_SECRET,
      })
      .expect(200);

    expect(res.body.refresh_token).toBeDefined();
    expect(res.body.refresh_token.length).toBe(128);
    expect(mockDb.storeOidcRefreshToken).toHaveBeenCalledWith(
      res.body.refresh_token, 5, OIDC_CLIENT_ID, expect.any(Date)
    );
  });

  it("exchanges refresh token for new tokens", async () => {
    mockDb.consumeOidcRefreshToken.mockResolvedValue({
      token: "old-refresh-token",
      user_id: 5,
      client_id: OIDC_CLIENT_ID,
    });
    mockDb.findUserById.mockResolvedValue({
      id: 5,
      email: "refresh@test.com",
      display_name: "Refresh User",
      google_id: "g-refresh",
      avatar_url: "https://example.com/pic.jpg",
    });

    const res = await request(app)
      .post("/auth/oidc/token")
      .send({
        grant_type: "refresh_token",
        refresh_token: "old-refresh-token",
        client_id: OIDC_CLIENT_ID,
        client_secret: OIDC_CLIENT_SECRET,
      })
      .expect(200);

    expect(res.body.access_token).toBeDefined();
    expect(res.body.id_token).toBeDefined();
    expect(res.body.refresh_token).toBeDefined();
    expect(res.body.refresh_token).not.toBe("old-refresh-token"); // rotating
    expect(res.body.token_type).toBe("Bearer");
    expect(res.body.expires_in).toBe(3600);
  });

  it("rejects invalid refresh token", async () => {
    mockDb.consumeOidcRefreshToken.mockResolvedValue(null);

    const res = await request(app)
      .post("/auth/oidc/token")
      .send({
        grant_type: "refresh_token",
        refresh_token: "bad-token",
        client_id: OIDC_CLIENT_ID,
        client_secret: OIDC_CLIENT_SECRET,
      })
      .expect(400);

    expect(res.body.error).toBe("invalid_grant");
  });

  it("rejects refresh token with wrong client_id", async () => {
    mockDb.consumeOidcRefreshToken.mockResolvedValue({
      token: "stolen-token",
      user_id: 5,
      client_id: "foundry-agent",
    });

    const res = await request(app)
      .post("/auth/oidc/token")
      .send({
        grant_type: "refresh_token",
        refresh_token: "stolen-token",
        client_id: OIDC_CLIENT_ID,
        client_secret: OIDC_CLIENT_SECRET,
      })
      .expect(400);

    expect(res.body.error).toBe("invalid_grant");
    expect(res.body.error_description).toContain("client_id mismatch");
  });

  it("rejects missing refresh_token parameter", async () => {
    const res = await request(app)
      .post("/auth/oidc/token")
      .send({
        grant_type: "refresh_token",
        client_id: OIDC_CLIENT_ID,
        client_secret: OIDC_CLIENT_SECRET,
      })
      .expect(400);

    expect(res.body.error).toBe("invalid_grant");
    expect(res.body.error_description).toContain("refresh_token is required");
  });

  it("rejects invalid client credentials for refresh_token grant", async () => {
    const res = await request(app)
      .post("/auth/oidc/token")
      .send({
        grant_type: "refresh_token",
        refresh_token: "some-token",
        client_id: OIDC_CLIENT_ID,
        client_secret: "wrong-secret",
      })
      .expect(401);

    expect(res.body.error).toBe("invalid_client");
  });
});

describe("OIDC Skip-Google for Authenticated Users", () => {
  it("redirects directly to redirect_uri with auth code when user has valid cookie", async () => {
    const dbUser = {
      id: 42,
      email: "auth@test.com",
      display_name: "Auth User",
      firebase_uid: "fb-42",
      avatar_url: "https://example.com/pic.jpg",
    };
    mockVerifyIdToken.mockResolvedValue({
      uid: "fb-42",
      email: "auth@test.com",
      name: "Auth User",
      picture: "https://example.com/pic.jpg",
      firebase: { sign_in_provider: "google.com" },
    });
    mockDb.upsertFirebaseUser.mockResolvedValue(dbUser);

    const res = await request(app)
      .get("/auth/oidc/authorize")
      .set("Cookie", "access_token=mock-firebase-id-token")
      .query({
        response_type: "code",
        client_id: OIDC_CLIENT_ID,
        redirect_uri: "https://ab.example.com/openid/callback",
        state: "test-state-123",
        scope: "openid email profile",
      })
      .expect(302);

    // Should redirect to the client's redirect_uri, NOT Google
    expect(res.headers.location).toContain("ab.example.com/openid/callback");
    expect(res.headers.location).toContain("code=");
    expect(res.headers.location).toContain("state=test-state-123");
    expect(res.headers.location).not.toContain("accounts.google.com");

    expect(mockDb.storeOidcAuthCode).toHaveBeenCalledWith(
      expect.any(String), 42, "https://ab.example.com/openid/callback", OIDC_CLIENT_ID,
      "", "", expect.objectContaining({ email: "auth@test.com" })
    );
  });

  it("falls through to Google redirect with invalid cookie", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("Invalid token"));

    const res = await request(app)
      .get("/auth/oidc/authorize")
      .set("Cookie", "access_token=invalid-firebase-token")
      .query({
        response_type: "code",
        client_id: OIDC_CLIENT_ID,
        redirect_uri: "https://ab.example.com/openid/callback",
        state: "test-state",
      })
      .expect(302);

    expect(res.headers.location).toContain("accounts.google.com");
  });

  it("falls through to Google redirect with no cookie", async () => {
    const res = await request(app)
      .get("/auth/oidc/authorize")
      .query({
        response_type: "code",
        client_id: OIDC_CLIENT_ID,
        redirect_uri: "https://ab.example.com/openid/callback",
        state: "test-state",
      })
      .expect(302);

    expect(res.headers.location).toContain("accounts.google.com");
  });

  it("falls through to Google redirect when user not found in DB", async () => {
    mockVerifyIdToken.mockResolvedValue({
      uid: "fb-999",
      email: "gone@test.com",
      name: "Gone",
      firebase: { sign_in_provider: "google.com" },
    });
    mockDb.upsertFirebaseUser.mockResolvedValue(null);

    const res = await request(app)
      .get("/auth/oidc/authorize")
      .set("Cookie", "access_token=mock-firebase-token")
      .query({
        response_type: "code",
        client_id: OIDC_CLIENT_ID,
        redirect_uri: "https://ab.example.com/openid/callback",
        state: "test-state",
      })
      .expect(302);

    expect(res.headers.location).toContain("accounts.google.com");
  });
});

describe("OIDC Persistent Access Tokens", () => {
  it("stores access token via storeOidcAccessToken on token exchange", async () => {
    mockDb.consumeOidcAuthCode.mockResolvedValue({
      code: "persist-code",
      user_id: 7,
      redirect_uri: "https://ab.example.com/cb",
      client_id: OIDC_CLIENT_ID,
      google_claims: { email: "persist@test.com", name: "Persist", sub: "g-p" },
    });

    const res = await request(app)
      .post("/auth/oidc/token")
      .send({
        grant_type: "authorization_code",
        code: "persist-code",
        client_id: OIDC_CLIENT_ID,
        client_secret: OIDC_CLIENT_SECRET,
      })
      .expect(200);

    expect(mockDb.storeOidcAccessToken).toHaveBeenCalledWith(
      res.body.access_token, 7,
      expect.objectContaining({ email: "persist@test.com" }),
      expect.any(Date)
    );
  });
});

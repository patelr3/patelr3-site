import { jest } from "@jest/globals";
import bcrypt from "bcryptjs";

// Mock all DB functions BEFORE importing app
const mockDb = {
  initDb: jest.fn(),
  findUserByEmail: jest.fn(),
  createLocalUser: jest.fn(),
  upsertGoogleUser: jest.fn(),
  listServices: jest.fn(),
  getServiceBySlug: jest.fn(),
  updateService: jest.fn(),
  getUserAccess: jest.fn(),
  grantAccess: jest.fn(),
  createAccessRequest: jest.fn(),
  listAccessRequests: jest.fn(),
  updateAccessRequest: jest.fn(),
  getUserPendingRequests: jest.fn(),
  findUserById: jest.fn(),
  listUsers: jest.fn(),
  updateUserRole: jest.fn(),
  updateUserPassword: jest.fn(),
  touchLastLogin: jest.fn(),
  deleteUser: jest.fn(),
  createResetToken: jest.fn(),
  findResetToken: jest.fn(),
  deleteResetToken: jest.fn(),
  storeOidcAuthCode: jest.fn(),
  consumeOidcAuthCode: jest.fn(),
  storeOidcAccessToken: jest.fn(),
  getOidcAccessToken: jest.fn(),
  deleteExpiredOidcTokens: jest.fn().mockResolvedValue(),
  storeOidcRefreshToken: jest.fn(),
  consumeOidcRefreshToken: jest.fn(),
  getOrCreateThread: jest.fn(),
  getUserThreads: jest.fn(),
  deleteThread: jest.fn(),
  createThread: jest.fn(),
  getThreadById: jest.fn(),
  addChatMessage: jest.fn(),
  getChatMessages: jest.fn(),
  getChatMessageCount: jest.fn(),
  updateThreadSummary: jest.fn(),
  getThreadSummary: jest.fn(),
  storeVaultKey: jest.fn(),
  getWrappedVaultKey: jest.fn(),
  getDebugMode: jest.fn().mockResolvedValue(false),
  setDebugMode: jest.fn().mockResolvedValue(false),
};

jest.unstable_mockModule("../src/db.js", () => mockDb);

jest.unstable_mockModule("@azure/identity", () => ({
  DefaultAzureCredential: jest.fn().mockImplementation(() => ({
    getToken: jest.fn().mockResolvedValue({ token: "mock-azure-token" }),
  })),
}));

const { default: app } = await import("../src/app.js");
import request from "supertest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "change-me";

function makeToken(payload = {}) {
  return jwt.sign(
    { sub: "1", email: "test@test.com", name: "Test", role: "user", ...payload },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

function adminToken() {
  return makeToken({ sub: "99", email: "admin@test.com", name: "Admin", role: "admin" });
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: touchLastLogin resolves
  mockDb.touchLastLogin.mockResolvedValue(undefined);
});

// ── POST /auth/register ────────────────────────────────────────

describe("POST /auth/register", () => {
  it("creates a new user and returns 201", async () => {
    mockDb.findUserByEmail.mockResolvedValue(null);
    mockDb.createLocalUser.mockResolvedValue({
      id: 1, email: "new@test.com", display_name: "new", role: "user",
    });

    const res = await request(app)
      .post("/auth/register")
      .send({ email: "new@test.com", password: "longpassword" });

    expect(res.status).toBe(201);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.email).toBe("new@test.com");
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  it("returns 400 when fields are missing", async () => {
    const res = await request(app).post("/auth/register").send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 when password is too short", async () => {
    const res = await request(app)
      .post("/auth/register")
      .send({ email: "a@b.com", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 characters/);
  });

  it("returns 409 when email already exists", async () => {
    mockDb.findUserByEmail.mockResolvedValue({ id: 1 });

    const res = await request(app)
      .post("/auth/register")
      .send({ email: "dup@test.com", password: "longpassword" });

    expect(res.status).toBe(409);
  });
});

// ── POST /auth/login ───────────────────────────────────────────

describe("POST /auth/login", () => {
  const PASSWORD = "correctpassword";
  let passwordHash;

  beforeAll(async () => {
    passwordHash = await bcrypt.hash(PASSWORD, 4); // low rounds for speed
  });

  it("logs in with valid credentials", async () => {
    mockDb.findUserByEmail.mockResolvedValue({
      id: 2, email: "user@test.com", display_name: "User", role: "user",
      password_hash: passwordHash,
    });

    const res = await request(app)
      .post("/auth/login")
      .send({ email: "user@test.com", password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  it("returns 401 with wrong password", async () => {
    mockDb.findUserByEmail.mockResolvedValue({
      id: 2, email: "user@test.com", display_name: "User", role: "user",
      password_hash: passwordHash,
    });

    const res = await request(app)
      .post("/auth/login")
      .send({ email: "user@test.com", password: "wrongpassword" });

    expect(res.status).toBe(401);
  });

  it("returns 400 when fields are missing", async () => {
    const res = await request(app).post("/auth/login").send({});
    expect(res.status).toBe(400);
  });

  it("returns 401 when user not found", async () => {
    mockDb.findUserByEmail.mockResolvedValue(null);

    const res = await request(app)
      .post("/auth/login")
      .send({ email: "no@test.com", password: "whatever1" });

    expect(res.status).toBe(401);
  });
});

// ── GET /auth/me ───────────────────────────────────────────────

describe("GET /auth/me", () => {
  it("returns user info with valid JWT cookie", async () => {
    const token = makeToken();
    const res = await request(app)
      .get("/auth/me")
      .set("Cookie", `access_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.email).toBe("test@test.com");
  });

  it("returns 401 without cookie", async () => {
    const res = await request(app).get("/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.authenticated).toBe(false);
  });
});

// ── GET /auth/verify ───────────────────────────────────────────

describe("GET /auth/verify", () => {
  it("returns 200 with auth headers for valid JWT", async () => {
    const token = makeToken();
    const res = await request(app)
      .get("/auth/verify")
      .set("Cookie", `access_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.headers["x-auth-user"]).toBe("test@test.com");
    expect(res.headers["x-auth-role"]).toBe("user");
  });

  it("returns 401 without cookie", async () => {
    const res = await request(app).get("/auth/verify");
    expect(res.status).toBe(401);
  });
});

// ── GET /auth/logout ───────────────────────────────────────────

describe("GET /auth/logout", () => {
  it("redirects and clears cookie", async () => {
    const res = await request(app).get("/auth/logout");
    expect(res.status).toBe(302);
    const cookies = res.headers["set-cookie"];
    expect(cookies).toBeDefined();
    expect(cookies.some((c) => c.includes("access_token=;"))).toBe(true);
  });
});

// ── GET /auth/services ─────────────────────────────────────────

describe("GET /auth/services", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/auth/services");
    expect(res.status).toBe(401);
  });

  it("returns services list for authenticated user", async () => {
    mockDb.listServices.mockResolvedValue([
      { id: 1, slug: "svc1", name: "Service 1", description: "desc", is_visible: true, is_restricted: false },
      { id: 2, slug: "svc2", name: "Service 2", description: "desc", is_visible: true, is_restricted: true },
    ]);
    mockDb.getUserAccess.mockResolvedValue([2]);
    mockDb.getUserPendingRequests.mockResolvedValue([]);

    const token = makeToken();
    const res = await request(app)
      .get("/auth/services")
      .set("Cookie", `access_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].hasAccess).toBe(true);   // unrestricted
    expect(res.body[1].hasAccess).toBe(true);    // user has access
  });

  it("marks restricted services without access", async () => {
    mockDb.listServices.mockResolvedValue([
      { id: 3, slug: "svc3", name: "Restricted", description: "", is_visible: true, is_restricted: true },
    ]);
    mockDb.getUserAccess.mockResolvedValue([]);
    mockDb.getUserPendingRequests.mockResolvedValue([3]);

    const token = makeToken();
    const res = await request(app)
      .get("/auth/services")
      .set("Cookie", `access_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body[0].hasAccess).toBe(false);
    expect(res.body[0].pendingRequest).toBe(true);
  });
});

// ── GET /auth/account ──────────────────────────────────────────

describe("GET /auth/account", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/auth/account");
    expect(res.status).toBe(401);
  });

  it("returns account details with isGoogleUser", async () => {
    mockDb.findUserById.mockResolvedValue({
      id: 1, email: "test@test.com", display_name: "Test",
      role: "user", password_hash: null, google_id: "g123", created_at: "2024-01-01",
    });

    const token = makeToken();
    const res = await request(app)
      .get("/auth/account")
      .set("Cookie", `access_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.isGoogleUser).toBe(true);
    expect(res.body.hasPassword).toBe(false);
    expect(res.body.email).toBe("test@test.com");
  });

  it("returns hasPassword true for local user", async () => {
    mockDb.findUserById.mockResolvedValue({
      id: 1, email: "test@test.com", display_name: "Test",
      role: "user", password_hash: "$2a$12$abc", google_id: null, created_at: "2024-01-01",
    });

    const token = makeToken();
    const res = await request(app)
      .get("/auth/account")
      .set("Cookie", `access_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.isGoogleUser).toBe(false);
    expect(res.body.hasPassword).toBe(true);
  });
});

// ── GET /auth/users (admin) ────────────────────────────────────

describe("GET /auth/users", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/auth/users");
    expect(res.status).toBe(401);
  });

  it("returns 403 for regular user", async () => {
    const token = makeToken({ role: "user" });
    const res = await request(app)
      .get("/auth/users")
      .set("Cookie", `access_token=${token}`);
    expect(res.status).toBe(403);
  });

  it("returns users list for admin", async () => {
    const users = [
      { id: 1, email: "a@b.com", display_name: "A", role: "user" },
      { id: 2, email: "c@d.com", display_name: "C", role: "admin" },
    ];
    mockDb.listUsers.mockResolvedValue(users);

    const token = adminToken();
    const res = await request(app)
      .get("/auth/users")
      .set("Cookie", `access_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

// ── PATCH /auth/users/:id/role ─────────────────────────────────

describe("PATCH /auth/users/:id/role", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).patch("/auth/users/1/role").send({ role: "admin" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for regular user", async () => {
    const token = makeToken({ role: "user" });
    const res = await request(app)
      .patch("/auth/users/1/role")
      .send({ role: "admin" })
      .set("Cookie", `access_token=${token}`);
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid role value", async () => {
    const token = adminToken();
    const res = await request(app)
      .patch("/auth/users/1/role")
      .send({ role: "superadmin" })
      .set("Cookie", `access_token=${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Role must be/);
  });

  it("updates role for admin", async () => {
    mockDb.updateUserRole.mockResolvedValue({ id: 1, email: "a@b.com", role: "admin" });

    const token = adminToken();
    const res = await request(app)
      .patch("/auth/users/1/role")
      .send({ role: "admin" })
      .set("Cookie", `access_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.role).toBe("admin");
  });
});

// ── DELETE /auth/users/:id ─────────────────────────────────────

describe("DELETE /auth/users/:id", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).delete("/auth/users/1");
    expect(res.status).toBe(401);
  });

  it("returns 403 for regular user", async () => {
    const token = makeToken({ role: "user" });
    const res = await request(app)
      .delete("/auth/users/1")
      .set("Cookie", `access_token=${token}`);
    expect(res.status).toBe(403);
  });

  it("prevents admin from deleting self", async () => {
    const token = adminToken(); // sub: "99"
    const res = await request(app)
      .delete("/auth/users/99")
      .set("Cookie", `access_token=${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own account/);
  });

  it("deletes another user as admin", async () => {
    mockDb.deleteUser.mockResolvedValue(true);

    const token = adminToken();
    const res = await request(app)
      .delete("/auth/users/5")
      .set("Cookie", `access_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 404 when user not found", async () => {
    mockDb.deleteUser.mockResolvedValue(false);

    const token = adminToken();
    const res = await request(app)
      .delete("/auth/users/999")
      .set("Cookie", `access_token=${token}`);

    expect(res.status).toBe(404);
  });
});

// ── GET /auth/account includes debugMode ───────────────────────

describe("GET /auth/account debugMode", () => {
  it("returns debugMode false by default", async () => {
    mockDb.findUserById.mockResolvedValue({
      id: 1, email: "test@test.com", display_name: "Test",
      role: "user", password_hash: null, google_id: "g123",
      debug_mode: false, created_at: "2024-01-01",
    });

    const token = makeToken();
    const res = await request(app)
      .get("/auth/account")
      .set("Cookie", `access_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.debugMode).toBe(false);
  });

  it("returns debugMode true when enabled", async () => {
    mockDb.findUserById.mockResolvedValue({
      id: 1, email: "test@test.com", display_name: "Test",
      role: "user", password_hash: null, google_id: "g123",
      debug_mode: true, created_at: "2024-01-01",
    });

    const token = makeToken();
    const res = await request(app)
      .get("/auth/account")
      .set("Cookie", `access_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.debugMode).toBe(true);
  });
});

// ── PATCH /auth/debug-mode ─────────────────────────────────────

describe("PATCH /auth/debug-mode", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app)
      .patch("/auth/debug-mode")
      .send({ enabled: true });
    expect(res.status).toBe(401);
  });

  it("returns 400 when enabled is not boolean", async () => {
    const token = makeToken();
    const res = await request(app)
      .patch("/auth/debug-mode")
      .set("Cookie", `access_token=${token}`)
      .send({ enabled: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/boolean/);
  });

  it("enables debug mode", async () => {
    mockDb.setDebugMode.mockResolvedValue(true);

    const token = makeToken();
    const res = await request(app)
      .patch("/auth/debug-mode")
      .set("Cookie", `access_token=${token}`)
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.debugMode).toBe(true);
    expect(mockDb.setDebugMode).toHaveBeenCalledWith(1, true);
  });

  it("disables debug mode", async () => {
    mockDb.setDebugMode.mockResolvedValue(false);

    const token = makeToken();
    const res = await request(app)
      .patch("/auth/debug-mode")
      .set("Cookie", `access_token=${token}`)
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.debugMode).toBe(false);
    expect(mockDb.setDebugMode).toHaveBeenCalledWith(1, false);
  });
});

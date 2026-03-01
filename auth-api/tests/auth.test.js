import { jest } from "@jest/globals";

// Mock all DB functions BEFORE importing app
const mockDb = {
  initDb: jest.fn(),
  findUserByEmail: jest.fn(),
  upsertFirebaseUser: jest.fn(),
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

// Mock firebase-admin/app and firebase-admin/auth
const mockVerifyIdToken = jest.fn();
jest.unstable_mockModule("firebase-admin/app", () => ({
  initializeApp: jest.fn(),
}));
jest.unstable_mockModule("firebase-admin/auth", () => ({
  getAuth: jest.fn(() => ({
    verifyIdToken: mockVerifyIdToken,
  })),
}));

const { default: app } = await import("../src/app.js");
import request from "supertest";

// Helper: mock a successful Firebase token verification + DB upsert
function mockFirebaseAuth(dbUser, firebaseOverrides = {}) {
  const firebaseUser = {
    uid: `firebase-${dbUser.id}`,
    email: dbUser.email,
    name: dbUser.display_name,
    picture: "",
    firebase: { sign_in_provider: "google.com" },
    ...firebaseOverrides,
  };
  mockVerifyIdToken.mockResolvedValue(firebaseUser);
  mockDb.upsertFirebaseUser.mockResolvedValue(dbUser);
  return "mock-firebase-id-token";
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.touchLastLogin.mockResolvedValue(undefined);
});

// ── GET /auth/me ───────────────────────────────────────────────

describe("GET /auth/me", () => {
  it("returns user info with valid Firebase token in cookie", async () => {
    const dbUser = { id: 1, email: "test@test.com", display_name: "Test", role: "user" };
    const token = mockFirebaseAuth(dbUser);
    const res = await request(app)
      .get("/auth/me")
      .set("Cookie", `access_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.email).toBe("test@test.com");
  });

  it("returns user info with valid Firebase token in Authorization header", async () => {
    const dbUser = { id: 1, email: "test@test.com", display_name: "Test", role: "user" };
    const token = mockFirebaseAuth(dbUser);
    const res = await request(app)
      .get("/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
  });

  it("returns 401 without token", async () => {
    const res = await request(app).get("/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("Invalid token"));
    const res = await request(app)
      .get("/auth/me")
      .set("Cookie", "access_token=bad-token");
    expect(res.status).toBe(401);
  });
});

// ── GET /auth/verify ───────────────────────────────────────────

describe("GET /auth/verify", () => {
  it("returns 200 with auth headers for valid Firebase token", async () => {
    const dbUser = { id: 1, email: "test@test.com", display_name: "Test", role: "user" };
    const token = mockFirebaseAuth(dbUser);
    const res = await request(app)
      .get("/auth/verify")
      .set("Cookie", `access_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.headers["x-auth-user"]).toBe("test@test.com");
    expect(res.headers["x-auth-role"]).toBe("user");
  });

  it("returns 401 without token", async () => {
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

    const dbUser = { id: 1, email: "test@test.com", display_name: "Test", role: "user" };
    const token = mockFirebaseAuth(dbUser);
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

    const dbUser = { id: 1, email: "test@test.com", display_name: "Test", role: "user" };
    const token = mockFirebaseAuth(dbUser);
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

  it("returns account details with provider info", async () => {
    const dbUser = {
      id: 1, email: "test@test.com", display_name: "Test",
      role: "user", created_at: "2024-01-01",
    };
    const token = mockFirebaseAuth(dbUser, { firebase: { sign_in_provider: "google.com" } });
    const res = await request(app)
      .get("/auth/account")
      .set("Cookie", `access_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("google.com");
    expect(res.body.email).toBe("test@test.com");
  });
});

// ── GET /auth/users (admin) ────────────────────────────────────

describe("GET /auth/users", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/auth/users");
    expect(res.status).toBe(401);
  });

  it("returns 403 for regular user", async () => {
    const dbUser = { id: 1, email: "test@test.com", display_name: "Test", role: "user" };
    const token = mockFirebaseAuth(dbUser);
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

    const dbUser = { id: 99, email: "admin@test.com", display_name: "Admin", role: "admin" };
    const token = mockFirebaseAuth(dbUser);
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
    const dbUser = { id: 1, email: "test@test.com", display_name: "Test", role: "user" };
    const token = mockFirebaseAuth(dbUser);
    const res = await request(app)
      .patch("/auth/users/1/role")
      .send({ role: "admin" })
      .set("Cookie", `access_token=${token}`);
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid role value", async () => {
    const dbUser = { id: 99, email: "admin@test.com", display_name: "Admin", role: "admin" };
    const token = mockFirebaseAuth(dbUser);
    const res = await request(app)
      .patch("/auth/users/1/role")
      .send({ role: "superadmin" })
      .set("Cookie", `access_token=${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Role must be/);
  });

  it("updates role for admin", async () => {
    mockDb.updateUserRole.mockResolvedValue({ id: 1, email: "a@b.com", role: "admin" });

    const dbUser = { id: 99, email: "admin@test.com", display_name: "Admin", role: "admin" };
    const token = mockFirebaseAuth(dbUser);
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
    const dbUser = { id: 1, email: "test@test.com", display_name: "Test", role: "user" };
    const token = mockFirebaseAuth(dbUser);
    const res = await request(app)
      .delete("/auth/users/1")
      .set("Cookie", `access_token=${token}`);
    expect(res.status).toBe(403);
  });

  it("prevents admin from deleting self", async () => {
    const dbUser = { id: 99, email: "admin@test.com", display_name: "Admin", role: "admin" };
    const token = mockFirebaseAuth(dbUser);
    const res = await request(app)
      .delete("/auth/users/99")
      .set("Cookie", `access_token=${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own account/);
  });

  it("deletes another user as admin", async () => {
    mockDb.deleteUser.mockResolvedValue(true);

    const dbUser = { id: 99, email: "admin@test.com", display_name: "Admin", role: "admin" };
    const token = mockFirebaseAuth(dbUser);
    const res = await request(app)
      .delete("/auth/users/5")
      .set("Cookie", `access_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 404 when user not found", async () => {
    mockDb.deleteUser.mockResolvedValue(false);

    const dbUser = { id: 99, email: "admin@test.com", display_name: "Admin", role: "admin" };
    const token = mockFirebaseAuth(dbUser);
    const res = await request(app)
      .delete("/auth/users/999")
      .set("Cookie", `access_token=${token}`);

    expect(res.status).toBe(404);
  });
});

import { jest } from "@jest/globals";

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
  getThreadLastResponseId: jest.fn().mockResolvedValue(null),
  updateThreadLastResponseId: jest.fn().mockResolvedValue(),
  getThreadFoundryConversationId: jest.fn().mockResolvedValue(null),
  updateThreadFoundryConversationId: jest.fn().mockResolvedValue(),
  storeVaultKey: jest.fn(),
  getWrappedVaultKey: jest.fn(),
};

jest.unstable_mockModule("../src/db.js", () => mockDb);

jest.unstable_mockModule("@azure/identity", () => ({
  DefaultAzureCredential: jest.fn().mockImplementation(() => ({
    getToken: jest.fn().mockResolvedValue({ token: "mock-azure-token" }),
  })),
}));

jest.unstable_mockModule("@azure/ai-projects", () => ({
  AIProjectClient: jest.fn().mockImplementation(() => ({
    getOpenAIClient: jest.fn().mockReturnValue({
      responses: {
        create: jest.fn().mockResolvedValue({ id: "mock-response", output: [], status: "completed" }),
        stream: jest.fn(),
      },
      conversations: {
        create: jest.fn().mockResolvedValue({ id: "conv_mock123" }),
      },
    }),
  })),
}));

const { default: app } = await import("../src/app.js");
import request from "supertest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "change-me";

function makeToken(payload = {}) {
  return jwt.sign(
    { sub: "1", email: "user1@test.com", name: "User1", role: "user", ...payload },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

// User 1 owns thread 10, User 2 (sub=2) is an attacker
const user1Token = makeToken({ sub: "1", email: "user1@test.com" });
const user2Token = makeToken({ sub: "2", email: "attacker@test.com" });

const thread10 = {
  id: 10,
  user_id: 1,
  title: "User1 private thread",
  foundry_thread_id: "",
  created_at: new Date(),
  updated_at: new Date(),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.touchLastLogin.mockResolvedValue(undefined);
});

// ── GET /auth/chat/threads/:threadId/messages — ownership ──────

describe("GET /auth/chat/threads/:threadId/messages", () => {
  it("returns messages when the requesting user owns the thread", async () => {
    mockDb.getThreadById.mockResolvedValue(thread10);
    mockDb.getWrappedVaultKey.mockResolvedValue(null);
    mockDb.getChatMessages.mockResolvedValue([
      { id: 1, role: "user", content: "hello", created_at: new Date() },
      { id: 2, role: "assistant", content: "hi there", created_at: new Date() },
    ]);

    const res = await request(app)
      .get("/auth/chat/threads/10/messages")
      .set("Cookie", `access_token=${user1Token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].content).toBe("hello");
  });

  it("returns 404 when another user tries to access the thread", async () => {
    mockDb.getThreadById.mockResolvedValue(thread10); // user_id=1

    const res = await request(app)
      .get("/auth/chat/threads/10/messages")
      .set("Cookie", `access_token=${user2Token}`); // user_id=2

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Thread not found");
    // Ensure messages were NOT fetched
    expect(mockDb.getChatMessages).not.toHaveBeenCalled();
  });

  it("returns 404 when thread does not exist", async () => {
    mockDb.getThreadById.mockResolvedValue(null);

    const res = await request(app)
      .get("/auth/chat/threads/999/messages")
      .set("Cookie", `access_token=${user1Token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Thread not found");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get("/auth/chat/threads/10/messages");
    expect(res.status).toBe(401);
  });
});

// ── POST /auth/chat/threads/:threadId/messages — ownership ─────

describe("POST /auth/chat/threads/:threadId/messages", () => {
  it("returns 404 when another user tries to post to the thread", async () => {
    mockDb.getThreadById.mockResolvedValue(thread10); // user_id=1

    const res = await request(app)
      .post("/auth/chat/threads/10/messages")
      .set("Cookie", `access_token=${user2Token}`) // user_id=2
      .send({ content: "sneaky message" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Thread not found");
    // Ensure no message was stored
    expect(mockDb.addChatMessage).not.toHaveBeenCalled();
  });

  it("returns 404 when thread does not exist", async () => {
    mockDb.getThreadById.mockResolvedValue(null);

    const res = await request(app)
      .post("/auth/chat/threads/999/messages")
      .set("Cookie", `access_token=${user1Token}`)
      .send({ content: "hello" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Thread not found");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/auth/chat/threads/10/messages")
      .send({ content: "hello" });
    expect(res.status).toBe(401);
  });
});

// ── GET /auth/chat/threads — correctly scoped to user ──────────

describe("GET /auth/chat/threads", () => {
  it("returns only the requesting user's threads", async () => {
    mockDb.getUserThreads.mockResolvedValue([thread10]);

    const res = await request(app)
      .get("/auth/chat/threads")
      .set("Cookie", `access_token=${user1Token}`);

    expect(res.status).toBe(200);
    expect(mockDb.getUserThreads).toHaveBeenCalledWith(1);
  });
});

// ── DELETE /auth/chat/threads/:threadId — already secure ───────

describe("DELETE /auth/chat/threads/:threadId", () => {
  it("returns 404 when another user tries to delete the thread", async () => {
    mockDb.deleteThread.mockResolvedValue(null); // deleteThread checks user_id

    const res = await request(app)
      .delete("/auth/chat/threads/10")
      .set("Cookie", `access_token=${user2Token}`);

    expect(res.status).toBe(404);
    expect(mockDb.deleteThread).toHaveBeenCalledWith(2, "10");
  });
});

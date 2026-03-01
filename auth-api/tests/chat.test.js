import { jest } from "@jest/globals";

// Mock tracing before importing app
jest.unstable_mockModule("../src/tracing.js", () => ({
  trace: {
    getTracer: () => ({
      startSpan: () => ({
        setStatus: jest.fn(),
        end: jest.fn(),
        spanContext: () => ({ traceId: "test-trace-id" }),
      }),
      startActiveSpan: jest.fn((_name, _opts, fn) => fn({
        setStatus: jest.fn(),
        addEvent: jest.fn(),
        end: jest.fn(),
        spanContext: () => ({ traceId: "test-trace-id" }),
      })),
    }),
  },
  context: {},
  SpanStatusCode: { OK: 1, ERROR: 2 },
}));

// Mock DB functions
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

// Mock firebase-admin
const mockVerifyIdToken = jest.fn();
jest.unstable_mockModule("firebase-admin/app", () => ({
  initializeApp: jest.fn(),
}));
jest.unstable_mockModule("firebase-admin/auth", () => ({
  getAuth: jest.fn(() => ({
    verifyIdToken: mockVerifyIdToken,
  })),
}));

// Mock @azure/ai-projects and @azure/identity
const mockConversationsCreate = jest.fn();
const mockResponsesCreate = jest.fn();
const mockGetOpenAIClient = jest.fn(() => ({
  conversations: { create: mockConversationsCreate },
  responses: { create: mockResponsesCreate },
}));
jest.unstable_mockModule("@azure/ai-projects", () => ({
  AIProjectClient: jest.fn().mockImplementation(() => ({
    getOpenAIClient: mockGetOpenAIClient,
  })),
}));
jest.unstable_mockModule("@azure/identity", () => ({
  DefaultAzureCredential: jest.fn(),
}));

// Set env vars before importing app
process.env.FOUNDRY_PROJECT_ENDPOINT = "https://test-endpoint.azure.com";
process.env.FOUNDRY_AGENT_NAME = "test-agent";

const { default: app } = await import("../src/app.js");
import request from "supertest";

function mockFirebaseAuth(dbUser) {
  const firebaseUser = {
    uid: `firebase-${dbUser.id}`,
    email: dbUser.email,
    name: dbUser.display_name,
    picture: "",
    firebase: { sign_in_provider: "google.com" },
  };
  mockVerifyIdToken.mockResolvedValue(firebaseUser);
  mockDb.upsertFirebaseUser.mockResolvedValue(dbUser);
  return "mock-firebase-id-token";
}

const testUser = {
  id: 1,
  email: "test@example.com",
  display_name: "Test User",
  role: "user",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.touchLastLogin.mockResolvedValue(undefined);
});

describe("Chat API", () => {
  describe("GET /auth/chat/health", () => {
    it("returns 401 without auth", async () => {
      const res = await request(app).get("/auth/chat/health");
      expect(res.status).toBe(401);
    });

    it("returns 200 with auth", async () => {
      const token = mockFirebaseAuth(testUser);
      const res = await request(app)
        .get("/auth/chat/health")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.agent).toBe("test-agent");
    });
  });

  describe("POST /auth/chat/conversations", () => {
    it("returns 401 without auth", async () => {
      const res = await request(app).post("/auth/chat/conversations");
      expect(res.status).toBe(401);
    });

    it("creates a conversation and returns conversationId", async () => {
      const token = mockFirebaseAuth(testUser);
      mockConversationsCreate.mockResolvedValue({ id: "conv_abc123" });

      const res = await request(app)
        .post("/auth/chat/conversations")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(201);
      expect(res.body.conversationId).toBe("conv_abc123");
      expect(mockConversationsCreate).toHaveBeenCalled();
    });

    it("returns 502 when Foundry fails", async () => {
      const token = mockFirebaseAuth(testUser);
      mockConversationsCreate.mockRejectedValue(new Error("Foundry down"));

      const res = await request(app)
        .post("/auth/chat/conversations")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(502);
    });
  });

  describe("POST /auth/chat/conversations/:id/messages", () => {
    it("returns 401 without auth", async () => {
      const res = await request(app)
        .post("/auth/chat/conversations/conv_123/messages")
        .send({ message: "hello" });
      expect(res.status).toBe(401);
    });

    it("returns 400 without message", async () => {
      const token = mockFirebaseAuth(testUser);
      const res = await request(app)
        .post("/auth/chat/conversations/conv_123/messages")
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("message is required");
    });

    it("streams SSE events for a successful response", async () => {
      const token = mockFirebaseAuth(testUser);

      // Mock async iterable response from Foundry
      const events = [
        {
          type: "response.output_item.done",
          response: { id: "resp_123" },
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hello! I can help with budgets." }],
          },
        },
        {
          type: "response.completed",
          response: { id: "resp_123", status: "completed" },
        },
      ];

      mockResponsesCreate.mockResolvedValue({
        [Symbol.asyncIterator]: async function* () {
          for (const event of events) yield event;
        },
      });

      const res = await request(app)
        .post("/auth/chat/conversations/conv_123/messages")
        .set("Authorization", `Bearer ${token}`)
        .send({ message: "What can you do?" });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      expect(res.text).toContain("event: message");
      expect(res.text).toContain("Hello! I can help with budgets.");
      expect(res.text).toContain("event: done");
    });

    it("handles OAuth consent request", async () => {
      const token = mockFirebaseAuth(testUser);

      const events = [
        {
          type: "response.output_item.done",
          response: { id: "resp_456" },
          item: {
            type: "oauth_consent_request",
            consent_link: "https://consent.azure.com/login?data=xyz",
          },
        },
        {
          type: "response.completed",
          response: { id: "resp_456", status: "completed" },
        },
      ];

      mockResponsesCreate.mockResolvedValue({
        [Symbol.asyncIterator]: async function* () {
          for (const event of events) yield event;
        },
      });

      const res = await request(app)
        .post("/auth/chat/conversations/conv_123/messages")
        .set("Authorization", `Bearer ${token}`)
        .send({ message: "Check my budget" });

      expect(res.status).toBe(200);
      expect(res.text).toContain("event: oauth_consent");
      expect(res.text).toContain("https://consent.azure.com/login?data=xyz");
    });

    it("handles stream errors gracefully", async () => {
      const token = mockFirebaseAuth(testUser);

      mockResponsesCreate.mockRejectedValue(new Error("Foundry API error"));

      const res = await request(app)
        .post("/auth/chat/conversations/conv_123/messages")
        .set("Authorization", `Bearer ${token}`)
        .send({ message: "hello" });

      expect(res.status).toBe(200); // SSE always starts with 200
      expect(res.text).toContain("event: error");
      expect(res.text).toContain("Foundry API error");
    });

    it("passes previousResponseId when provided", async () => {
      const token = mockFirebaseAuth(testUser);

      const events = [
        {
          type: "response.completed",
          response: { id: "resp_789", status: "completed" },
        },
      ];

      mockResponsesCreate.mockResolvedValue({
        [Symbol.asyncIterator]: async function* () {
          for (const event of events) yield event;
        },
      });

      await request(app)
        .post("/auth/chat/conversations/conv_123/messages")
        .set("Authorization", `Bearer ${token}`)
        .send({ message: "Continue", previousResponseId: "resp_456" });

      expect(mockResponsesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          previous_response_id: "resp_456",
        })
      );
    });
  });
});

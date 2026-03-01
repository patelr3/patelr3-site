import { jest } from "@jest/globals";
import request from "supertest";

const mockJwtVerify = jest.fn();
jest.unstable_mockModule("jose", () => ({
  createRemoteJWKSet: () => {},
  jwtVerify: mockJwtVerify,
}));

const { default: app } = await import("../src/app.js");

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /", () => {
  it("without auth returns 'Hello, stranger!' with role 'unknown'", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Hello, stranger!");
    expect(res.body.role).toBe("unknown");
    expect(res.body.service).toBe("hello-world");
  });

  it("with x-auth-user header returns greeting with that user", async () => {
    const res = await request(app)
      .get("/")
      .set("x-auth-user", "alice@example.com")
      .set("x-auth-role", "admin");
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Hello, alice@example.com!");
    expect(res.body.role).toBe("admin");
  });

  it("with valid Firebase token cookie returns greeting with email", async () => {
    mockJwtVerify.mockResolvedValueOnce({
      payload: { email: "bob@example.com", sub: "firebase-uid" },
    });
    const res = await request(app)
      .get("/")
      .set("Cookie", "access_token=valid.firebase.token");
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Hello, bob@example.com!");
    expect(res.body.role).toBe("user");
  });

  it("with invalid token falls back to headers or defaults", async () => {
    mockJwtVerify.mockRejectedValueOnce(new Error("invalid token"));
    const res = await request(app)
      .get("/")
      .set("Cookie", "access_token=bad.token.value")
      .set("x-auth-user", "fallback@example.com")
      .set("x-auth-role", "viewer");
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Hello, fallback@example.com!");
    expect(res.body.role).toBe("viewer");
  });
});

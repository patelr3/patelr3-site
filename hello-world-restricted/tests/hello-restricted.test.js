import { jest } from "@jest/globals";
import request from "supertest";

const mockJwtVerify = jest.fn();
jest.unstable_mockModule("jose", () => ({
  createRemoteJWKSet: () => {},
  jwtVerify: mockJwtVerify,
}));

const { default: app } = await import("../src/app.js");

describe("hello-world-restricted", () => {
  test("GET /health returns 200 with status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  test("GET / without auth returns message with stranger", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.message).toContain("stranger");
    expect(res.body.service).toBe("hello-world-restricted");
  });

  test("GET / with valid Firebase token cookie returns greeting with email", async () => {
    mockJwtVerify.mockResolvedValueOnce({
      payload: { email: "alice@example.com", sub: "firebase-uid" },
    });
    const res = await request(app)
      .get("/")
      .set("Cookie", "access_token=valid.firebase.token");
    expect(res.status).toBe(200);
    expect(res.body.message).toContain("alice@example.com");
    expect(res.body.role).toBe("user");
  });

  test("response always includes secret field", async () => {
    const res = await request(app).get("/");
    expect(res.body).toHaveProperty("secret");
  });
});

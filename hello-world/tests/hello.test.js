import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../src/app.js";

const SECRET = "change-me";

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

  it("with valid JWT cookie returns greeting with JWT email", async () => {
    const token = jwt.sign({ email: "bob@example.com", role: "editor" }, SECRET);
    const res = await request(app)
      .get("/")
      .set("Cookie", `access_token=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Hello, bob@example.com!");
    expect(res.body.role).toBe("editor");
  });

  it("with invalid JWT cookie falls back to headers or defaults", async () => {
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

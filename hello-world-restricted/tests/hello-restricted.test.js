import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../src/app.js";

const SECRET = "change-me";

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

  test("GET / with valid JWT cookie returns greeting with JWT email", async () => {
    const token = jwt.sign({ email: "alice@example.com", role: "admin" }, SECRET);
    const res = await request(app)
      .get("/")
      .set("Cookie", `access_token=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toContain("alice@example.com");
    expect(res.body.role).toBe("admin");
  });

  test("response always includes secret field", async () => {
    const res = await request(app).get("/");
    expect(res.body).toHaveProperty("secret");
  });
});

import express from "express";

const app = express();
const PORT = 5000;

app.get("/", (req, res) => {
  const user = req.headers["x-auth-user"] || "stranger";
  const role = req.headers["x-auth-role"] || "unknown";
  res.json({
    message: `Hello, ${user}!`,
    role,
    service: "hello-world",
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`hello-world listening on :${PORT}`);
});

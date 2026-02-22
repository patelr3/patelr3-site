import app from "./app.js";

const PORT = 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`hello-world listening on :${PORT}`);
});


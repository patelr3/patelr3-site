import app from "./app.js";

const PORT = 5001;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`hello-world-restricted listening on :${PORT}`);
});


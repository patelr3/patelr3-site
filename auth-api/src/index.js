import { initDb } from "./db.js";
import app from "./app.js";
import config from "./config.js";

initDb()
  .then(() => {
    app.listen(config.port, "0.0.0.0", () => {
      console.log(`auth-api listening on :${config.port}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });

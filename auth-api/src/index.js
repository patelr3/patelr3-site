import { initTracing, createLogger } from "@patelr3/tracing";

// Initialize tracing before any other imports that need instrumentation
initTracing("auth-api");

const logger = createLogger("auth-api");

import { initDb } from "./db.js";
import app from "./app.js";
import config from "./config.js";

initDb()
  .then(() => {
    app.listen(config.port, "0.0.0.0", () => {
      logger.info(`auth-api listening on :${config.port}`);
    });
  })
  .catch((err) => {
    logger.error({ err }, "Failed to initialize database");
    process.exit(1);
  });

import { initTracing, createLogger } from "@patelr3/tracing";

initTracing("hello-world-restricted");

const logger = createLogger("hello-world-restricted");

import app from "./app.js";

const PORT = 5001;

app.listen(PORT, "0.0.0.0", () => {
  logger.info(`hello-world-restricted listening on :${PORT}`);
});


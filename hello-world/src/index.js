import { initTracing, createLogger } from "@patelr3/tracing";

initTracing("hello-world");

const logger = createLogger("hello-world");

import app from "./app.js";

const PORT = 5000;

app.listen(PORT, "0.0.0.0", () => {
  logger.info(`hello-world listening on :${PORT}`);
});


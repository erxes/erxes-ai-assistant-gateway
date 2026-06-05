import { env, validateEnv } from "./config/env.js";
import { createApp } from "./app.js";
import { connectMongo } from "./db/mongo.js";
import { logger } from "./lib/logger.js";

const start = async () => {
  validateEnv();
  await connectMongo();
  const app = createApp();

  app.listen(env.PORT, () => {
    logger.info("Erxes AI Assistant Gateway listening", {
      port: env.PORT,
      nodeEnv: env.NODE_ENV,
    });
  });
};

start().catch((error) => {
  logger.error("Failed to start service", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});

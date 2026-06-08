import { env, validateEnv } from "./config/env.js";
import { createApp } from "./app.js";
import { connectMongo } from "./db/mongo.js";
import {
  startDiscordMessageGateway,
  stopDiscordMessageGateway,
} from "./discord/messageGateway.js";
import { logger } from "./lib/logger.js";

const start = async () => {
  validateEnv();
  await connectMongo();
  await startDiscordMessageGateway();
  const app = createApp();

  const server = app.listen(env.PORT, () => {
    logger.info("Erxes AI Assistant Gateway listening", {
      port: env.PORT,
      nodeEnv: env.NODE_ENV,
    });
  });

  const shutdown = async (signal: string) => {
    logger.info("Shutting down Erxes AI Assistant Gateway", { signal });
    await stopDiscordMessageGateway();
    server.close((error) => {
      if (error) {
        logger.error("Failed to close HTTP server", {
          error: error.message,
        });
        process.exit(1);
      }

      process.exit(0);
    });
  };

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
};

start().catch((error) => {
  logger.error("Failed to start service", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});

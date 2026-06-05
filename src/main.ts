import express from "express";
import type { ErrorRequestHandler } from "express";
import mongoose from "mongoose";

import { env, validateEnv } from "./config/env.js";
import { connectMongo } from "./db/mongo.js";
import { HttpError } from "./lib/errors.js";
import { logger } from "./lib/logger.js";
import { adminBindingsRouter } from "./routes/adminBindings.js";
import { adminInstallationsRouter } from "./routes/adminInstallations.js";
import { discordInteractionsRouter } from "./routes/discordInteractions.js";
import { discordOAuthRouter } from "./routes/discordOAuth.js";
import { healthRouter } from "./routes/health.js";
import { mockOpenClawRouter } from "./routes/mockOpenClaw.js";

const app = express();

app.disable("x-powered-by");

app.use("/health", healthRouter);
app.use(
  "/discord/interactions",
  express.raw({ type: "application/json" }),
  discordInteractionsRouter,
);

app.use(express.json({ limit: "1mb" }));

app.use("/discord/oauth", discordOAuthRouter);
app.use("/api/installations", adminInstallationsRouter);
app.use("/api/bindings", adminBindingsRouter);
app.use("/mock-openclaw", mockOpenClawRouter);

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.statusCode).json({
      error: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }

  if (
    error instanceof mongoose.Error.ValidationError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 11000)
  ) {
    res.status(400).json({ error: "Invalid or duplicate data" });
    return;
  }

  logger.error("Unhandled request error", {
    error: error instanceof Error ? error.message : String(error),
  });

  res.status(500).json({ error: "Internal server error" });
};

app.use(errorHandler);

const start = async () => {
  validateEnv();
  await connectMongo();

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

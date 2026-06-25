import express from "express";
import type { ErrorRequestHandler } from "express";
import mongoose from "mongoose";

import { env } from "./config/env.js";
import { HttpError } from "./lib/errors.js";
import { logger } from "./lib/logger.js";
import { adminBindingsRouter } from "./routes/adminBindings.js";
import { adminInstallationsRouter } from "./routes/adminInstallations.js";
import { discordInteractionsRouter } from "./routes/discordInteractions.js";
import { discordOAuthRouter } from "./routes/discordOAuth.js";
import { cronWebhookRouter } from "./routes/cronWebhook.js";
import { convertedFilesRouter } from "./routes/convertedFiles.js";
import { healthRouter } from "./routes/health.js";
import { mockOpenClawRouter } from "./routes/mockOpenClaw.js";

export const createApp = () => {
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
  app.use("/webhooks", cronWebhookRouter);
  app.use("/internal/converted", convertedFilesRouter);
  app.use("/api/installations", adminInstallationsRouter);
  app.use("/api/bindings", adminBindingsRouter);

  if (env.ENABLE_MOCK_OPENCLAW === "true") {
    app.use("/mock-openclaw", mockOpenClawRouter);
  }

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

  return app;
};

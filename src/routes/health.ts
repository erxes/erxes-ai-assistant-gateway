import { Router } from "express";

import { env } from "../config/env.js";
import { mongoHealth } from "../db/mongo.js";
import { getDiscordMessageGatewayStatus } from "../discord/messageGateway.js";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  const mongo = mongoHealth();
  const ok = mongo.readyState === 1;
  const statusCode = env.NODE_ENV === "production" && !ok ? 503 : 200;

  res.status(statusCode).json({
    ok,
    service: "erxes-ai-assistant-gateway",
    uptime: Math.floor(process.uptime()),
    mongo,
    discordMessageGateway: getDiscordMessageGatewayStatus(),
  });
});

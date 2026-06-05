import { Router } from "express";

import { mongoHealth } from "../db/mongo.js";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "erxes-ai-assistant-gateway",
    uptime: Math.floor(process.uptime()),
    mongo: mongoHealth(),
  });
});


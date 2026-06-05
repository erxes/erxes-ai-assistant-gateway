import { verifyKey } from "discord-interactions";
import type { NextFunction, Request, Response } from "express";

import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

export type DiscordRequest = Request & {
  discordInteraction?: unknown;
};

export const verifyDiscordRequest = (
  req: DiscordRequest,
  res: Response,
  next: NextFunction,
) => {
  const signature = req.header("x-signature-ed25519");
  const timestamp = req.header("x-signature-timestamp");
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(JSON.stringify(req.body ?? {}));

  if (!signature || !timestamp) {
    res.status(401).json({ error: "Missing Discord signature headers" });
    return;
  }

  if (!env.DISCORD_PUBLIC_KEY) {
    logger.error("Discord public key is not configured");
    res.status(500).json({ error: "Discord public key is not configured" });
    return;
  }

  const isValid = verifyKey(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY);

  if (!isValid) {
    res.status(401).json({ error: "Invalid Discord request signature" });
    return;
  }

  try {
    req.discordInteraction = JSON.parse(rawBody.toString("utf8"));
    next();
  } catch {
    res.status(400).json({ error: "Invalid JSON body" });
  }
};


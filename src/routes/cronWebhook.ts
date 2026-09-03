import crypto from "node:crypto";
import { Router } from "express";

import {
  getDiscordChannel,
  getDiscordGuildChannels,
  sendChannelMessage,
} from "../discord/api.js";
import { env } from "../config/env.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logger } from "../lib/logger.js";
import { DiscordAssistantBinding } from "../models/DiscordAssistantBinding.js";

// Bridge for OpenClaw cron jobs that should announce to a Discord channel.
// The managed runtime has no direct Discord, so a cron created with
//   --webhook "<gateway>/webhooks/discord-cron?assistant=<id>&token=<T>&channel=<channelId>"
// POSTs its finished payload here; the gateway posts the result to the channel
// using the shared bot (which has Administrator in the guild).
//
// PER-ASSISTANT SCOPING (tenant isolation):
//  - token = HMAC-SHA256(CRON_WEBHOOK_SECRET, assistantId) — each assistant has
//    its own token; a leaked token cannot forge another assistant's token.
//  - the target channel's guild MUST be a guild this assistantId is bound to,
//    so assistant A can never post into assistant B's server.
const expectedToken = (assistantId: string): string =>
  crypto
    .createHmac("sha256", env.CRON_WEBHOOK_SECRET)
    .update(assistantId)
    .digest("hex")
    .slice(0, 32);

const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

// Metadata-ish keys whose string values are never the human-facing result.
const META_KEY_RE =
  /^(id|jobId|runId|sessionId|sessionKey|messageId|conversationKey|status|stage|state|ts|time|createdAt|updatedAt|runAt|nextRun|url|webhook|webhookUrl|channel|channelId|to|account|accountId|provider|model|agent|agentId|name|kind|type|event|error|reason|category)$/i;

// Deep fallback: walk the payload and return the longest content-like string,
// skipping obvious metadata fields. Works regardless of OpenClaw's exact shape.
const deepLongestString = (value: unknown, depth = 0): string => {
  if (depth > 6) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    let best = "";
    for (const v of value) {
      const s = deepLongestString(v, depth + 1);
      if (s.length > best.length) best = s;
    }
    return best;
  }
  if (value && typeof value === "object") {
    let best = "";
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && META_KEY_RE.test(k)) continue;
      const s = deepLongestString(v, depth + 1);
      if (s.length > best.length) best = s;
    }
    return best;
  }
  return "";
};

// OpenClaw's cron webhook payload shape varies; pull the first plausible text,
// then fall back to the longest content-like string anywhere in the payload.
const extractText = (body: unknown): string => {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;
  const nested = (key: string): Record<string, unknown> | undefined => {
    const v = b[key];
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  };
  const payload = nested("payload");
  const result = nested("result");
  const data = nested("data");
  const candidates: unknown[] = [
    b.text, b.answer, b.summary, b.message, b.content, b.output,
    payload?.text, payload?.answer, payload?.summary, payload?.message, payload?.content,
    result?.text, result?.answer, result?.summary, result?.content,
    data?.text, data?.answer,
    typeof b.result === "string" ? b.result : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }
  const deep = deepLongestString(body).trim();
  return deep;
};

export const cronWebhookRouter = Router();

cronWebhookRouter.post(
  "/discord-cron",
  asyncHandler(async (req, res) => {
    const assistantId = String(req.query.assistant ?? req.query.assistantId ?? "");
    const token = String(req.query.token ?? "");
    const channelRef = String(req.query.channel ?? req.query.channelId ?? "")
      .trim()
      .replace(/^#/, "");

    if (!env.CRON_WEBHOOK_SECRET) {
      res.status(503).json({ error: "cron webhook not configured" });
      return;
    }
    if (!assistantId || !token || !safeEqual(token, expectedToken(assistantId))) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!channelRef) {
      res.status(400).json({ error: "missing channel" });
      return;
    }

    // The guild(s) this assistant is bound to.
    const bindings = await DiscordAssistantBinding.find({
      assistantId,
      enabled: true,
    })
      .select("discordGuildId")
      .lean();
    const guilds = [
      ...new Set(bindings.map((b) => b.discordGuildId).filter(Boolean) as string[]),
    ];
    if (guilds.length === 0) {
      res.status(403).json({ error: "assistant has no active discord binding" });
      return;
    }

    // Resolve the channel — accept either a numeric ID or a channel NAME, always
    // scoped to THIS assistant's own guild(s) (tenant isolation). Name resolution
    // lets a cron post into the channel it created without knowing the raw ID.
    let channelId = "";
    if (/^\d{5,25}$/.test(channelRef)) {
      try {
        const g = String((await getDiscordChannel(channelRef)).guild_id ?? "");
        if (g && guilds.includes(g)) channelId = channelRef;
      } catch {
        /* not found */
      }
      if (!channelId) {
        logger.info("cron-webhook: channel id not in assistant's guild (denied)", {
          assistantId,
          channelRef,
        });
        res.status(403).json({ error: "channel is not in this assistant's server" });
        return;
      }
    } else {
      const norm = channelRef.toLowerCase().replace(/\s+/g, "-");
      for (const g of guilds) {
        try {
          const found = (await getDiscordGuildChannels(g)).find(
            (c) => (c.name || "").toLowerCase() === norm,
          );
          if (found) {
            channelId = found.id;
            break;
          }
        } catch {
          /* skip guild */
        }
      }
      if (!channelId) {
        logger.info("cron-webhook: channel name not found in assistant's guild", {
          assistantId,
          channelRef,
        });
        res
          .status(404)
          .json({ error: "channel name not found in this assistant's server" });
        return;
      }
    }

    const text = extractText(req.body).trim();
    if (!text) {
      let bodyPreview = "";
      try {
        bodyPreview = JSON.stringify(req.body).slice(0, 1500);
      } catch {
        bodyPreview = String(req.body).slice(0, 500);
      }
      logger.info("cron-webhook: no text extracted, nothing to post", {
        channelId,
        bodyType: typeof req.body,
        bodyPreview,
      });
      res.status(204).end();
      return;
    }

    try {
      await sendChannelMessage(channelId, text);
      logger.info("cron-webhook: posted to channel", {
        channelId,
        length: text.length,
      });
      res.json({ ok: true });
    } catch (error) {
      logger.error("cron-webhook: failed to post to channel", {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({ error: "failed to post to channel" });
    }
  }),
);

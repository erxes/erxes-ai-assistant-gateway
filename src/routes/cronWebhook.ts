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
import type { AssistantRuntimeKind } from "../runtime/identity.js";

// Bridge for runtime cron jobs that should announce to a Discord channel.
// The managed runtime has no direct Discord, so a cron created with
//   --webhook "<gateway>/webhooks/discord-cron?assistant=<id>&token=<T>&channel=<channelId>"
// POSTs its finished payload here; the gateway posts the result to the channel
// using the shared bot and its explicitly configured guild permissions.
//
// SCOPING:
//  - Hermes and new OpenClaw URLs sign tenant + assistant + runtime kind.
//  - Existing OpenClaw URLs signed with assistantId remain valid, but can only
//    resolve OpenClaw (or pre-runtimeKind) bindings.
//  - The target channel's guild must belong to the resolved binding scope.
export type DiscordCronScope = {
  assistantId: string;
  tenantId?: string;
  runtimeKind?: AssistantRuntimeKind;
};

const cronTokenPayload = (scope: DiscordCronScope) =>
  scope.tenantId && scope.runtimeKind
    ? ["v2", scope.tenantId, scope.assistantId, scope.runtimeKind].join("\n")
    : scope.assistantId;

export const buildDiscordCronToken = (
  scope: DiscordCronScope,
  secret = env.CRON_WEBHOOK_SECRET,
): string =>
  crypto
    .createHmac("sha256", secret)
    .update(cronTokenPayload(scope))
    .digest("hex")
    .slice(0, 32);

const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

export const validateDiscordCronToken = (
  token: string,
  scope: DiscordCronScope,
  secret = env.CRON_WEBHOOK_SECRET,
) =>
  Boolean(
    token && secret && safeEqual(token, buildDiscordCronToken(scope, secret)),
  );

export const buildCronBindingQuery = (scope: DiscordCronScope) => {
  const identity = {
    assistantId: scope.assistantId,
    enabled: true,
  };

  if (scope.tenantId && scope.runtimeKind === "hermes") {
    return {
      ...identity,
      tenantId: scope.tenantId,
      runtimeKind: "hermes",
    };
  }

  if (scope.tenantId && scope.runtimeKind === "openclaw") {
    return {
      ...identity,
      tenantId: scope.tenantId,
      $or: [
        { runtimeKind: "openclaw" },
        { runtimeKind: { $exists: false } },
      ],
    };
  }

  // Backward compatibility for deployed OpenClaw cron URLs. Never allow a
  // legacy assistant-only token to select an explicitly-Hermes binding.
  return {
    ...identity,
    $or: [
      { runtimeKind: "openclaw" },
      { runtimeKind: { $exists: false } },
    ],
  };
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
    const tenantId = String(req.query.tenant ?? req.query.tenantId ?? "").trim();
    const runtimeKindValue = String(
      req.query.runtime ?? req.query.runtimeKind ?? "",
    ).trim();
    const channelRef = String(req.query.channel ?? req.query.channelId ?? "")
      .trim()
      .replace(/^#/, "");

    if (!env.CRON_WEBHOOK_SECRET) {
      res.status(503).json({ error: "cron webhook not configured" });
      return;
    }

    const hasScopedIdentity = Boolean(tenantId || runtimeKindValue);
    if (
      hasScopedIdentity &&
      (!tenantId ||
        (runtimeKindValue !== "openclaw" && runtimeKindValue !== "hermes"))
    ) {
      res.status(400).json({ error: "invalid runtime scope" });
      return;
    }

    const scope: DiscordCronScope = {
      assistantId: assistantId.trim(),
      ...(hasScopedIdentity
        ? {
            tenantId,
            runtimeKind: runtimeKindValue as AssistantRuntimeKind,
          }
        : {}),
    };

    if (!scope.assistantId || !validateDiscordCronToken(token, scope)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!channelRef) {
      res.status(400).json({ error: "missing channel" });
      return;
    }

    // The guild(s) this exact assistant runtime is bound to.
    const bindings = await DiscordAssistantBinding.find(
      buildCronBindingQuery(scope),
    )
      .select("discordGuildId discordChannelId")
      .lean();
    const guilds = [
      ...new Set(bindings.map((b) => b.discordGuildId).filter(Boolean) as string[]),
    ];
    const allowedChannelIds = new Set(
      bindings
        .map((binding) => binding.discordChannelId)
        .filter(Boolean) as string[],
    );
    if (guilds.length === 0) {
      res.status(403).json({ error: "assistant has no active discord binding" });
      return;
    }

    // Resolve the channel — accept either a numeric ID or a channel NAME, always
    // scoped to THIS assistant's own guild(s) (tenant isolation). Name resolution
    // lets a cron post into the channel it created without knowing the raw ID.
    let channelId = "";
    if (/^\d{5,25}$/.test(channelRef)) {
      if (!allowedChannelIds.has(channelRef)) {
        res.status(403).json({ error: "channel is not bound to this assistant" });
        return;
      }
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
            (c) =>
              allowedChannelIds.has(c.id) &&
              (c.name || "").toLowerCase() === norm,
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
      logger.info("cron-webhook: no text extracted, nothing to post", {
        channelId,
        bodyType: typeof req.body,
        bodyKeys:
          req.body && typeof req.body === "object" && !Array.isArray(req.body)
            ? Object.keys(req.body as Record<string, unknown>).slice(0, 20)
            : [],
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

import crypto from "node:crypto";
import { Router } from "express";

import {
  getDiscordChannel,
  getDiscordGuildChannels,
  sendChannelMessage,
  type DiscordChannel,
} from "../discord/api.js";
import {
  buildChannelBindingUpdate,
  type ChannelBindingContext,
} from "../discord/channelActions.js";
import { env } from "../config/env.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { HttpError } from "../lib/errors.js";
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

// GUILD_TEXT and GUILD_ANNOUNCEMENT: the channel types a cron report can land in.
const POSTABLE_CHANNEL_TYPES = new Set([0, 5]);

const BINDING_CONTEXT_FIELDS =
  "tenantId assistantId assistantName discordGuildId discordChannelId openclawUrl runtimeKind";

export type CronBindingRow = {
  tenantId?: string | null;
  assistantId?: string | null;
  assistantName?: string | null;
  discordGuildId?: string | null;
  discordChannelId?: string | null;
  openclawUrl?: string | null;
  runtimeKind?: string | null;
};

export type CronChannelDeps = {
  getChannel: (channelId: string) => Promise<DiscordChannel>;
  listGuildChannels: (guildId: string) => Promise<DiscordChannel[]>;
  findEnabledChannelBinding: (
    guildId: string,
    channelId: string,
  ) => Promise<CronBindingRow | null>;
  createBinding: (
    row: ReturnType<typeof buildChannelBindingUpdate>,
  ) => Promise<unknown>;
  log?: (
    level: "info" | "warn",
    message: string,
    meta: Record<string, unknown>,
  ) => void;
};

export type CronChannelResolution =
  | { ok: true; channelId: string; autoBound: boolean }
  | { ok: false; status: 403 | 404 | 500 | 502; error: string; reason: string };

const isDiscordNotFound = (error: unknown) =>
  error instanceof HttpError && error.statusCode === 404;

const isDuplicateKey = (error: unknown) =>
  (error as { code?: number } | null)?.code === 11000;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const normalizeChannelName = (value: string) =>
  value.toLowerCase().replace(/\s+/g, "-");

/**
 * Resolve a cron webhook's channel reference (numeric id or name) to a channel
 * in one of the assistant's own guilds. A channel that exists there but is not
 * yet bound is bound to this assistant (slash_only, so the assistant does not
 * start answering every message in a report channel), unless another
 * assistant already owns it.
 */
export const resolveCronChannel = async (
  input: { channelRef: string; ownBindings: CronBindingRow[] },
  deps: CronChannelDeps,
): Promise<CronChannelResolution> => {
  const { channelRef, ownBindings } = input;
  const guilds = [
    ...new Set(
      ownBindings.map((b) => b.discordGuildId).filter(Boolean) as string[],
    ),
  ];
  const allowedChannelIds = new Set(
    ownBindings.map((b) => b.discordChannelId).filter(Boolean) as string[],
  );

  const contextFor = (guildId: string): ChannelBindingContext | null => {
    const row =
      ownBindings.find(
        (b) => b.discordGuildId === guildId && b.tenantId && b.openclawUrl,
      ) ?? null;
    if (!row?.tenantId || !row.assistantId || !row.openclawUrl) return null;
    return {
      tenantId: row.tenantId,
      assistantId: row.assistantId,
      assistantName: row.assistantName ?? undefined,
      openclawUrl: row.openclawUrl,
      runtimeKind: row.runtimeKind === "hermes" ? "hermes" : "openclaw",
    };
  };

  const isOwn = (row: CronBindingRow, context: ChannelBindingContext) =>
    row.assistantId === context.assistantId &&
    row.tenantId === context.tenantId;

  const boundToAnother = (): CronChannelResolution => ({
    ok: false,
    status: 403,
    error: "channel is bound to another assistant",
    reason: "bound_to_other_assistant",
  });

  const autoBind = async (
    guildId: string,
    channelId: string,
  ): Promise<CronChannelResolution> => {
    const context = contextFor(guildId);
    if (!context) {
      return {
        ok: false,
        status: 500,
        error: "channel exists but could not be bound to this assistant",
        reason: "binding_context_missing",
      };
    }
    const existing = await deps.findEnabledChannelBinding(guildId, channelId);
    if (existing) {
      return isOwn(existing, context)
        ? { ok: true, channelId, autoBound: false }
        : boundToAnother();
    }
    try {
      await deps.createBinding(
        buildChannelBindingUpdate(context, guildId, channelId, "slash_only"),
      );
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      // Lost a race with a concurrent bind: whoever won owns the channel.
      const winner = await deps.findEnabledChannelBinding(guildId, channelId);
      if (winner && isOwn(winner, context)) {
        return { ok: true, channelId, autoBound: false };
      }
      return boundToAnother();
    }
    deps.log?.("info", "cron-webhook: auto-bound channel to assistant", {
      assistantId: context.assistantId,
      guildId,
      channelId,
    });
    return { ok: true, channelId, autoBound: true };
  };

  if (/^\d{5,25}$/.test(channelRef)) {
    let channel: DiscordChannel;
    try {
      channel = await deps.getChannel(channelRef);
    } catch (error) {
      if (isDiscordNotFound(error)) {
        return {
          ok: false,
          status: 404,
          error: "no such channel",
          reason: "channel_id_not_found",
        };
      }
      deps.log?.("warn", "cron-webhook: discord api error resolving channel", {
        channelRef,
        error: errorText(error),
      });
      return {
        ok: false,
        status: 502,
        error: "discord api error while resolving the channel",
        reason: "discord_api_error",
      };
    }
    const guildId = String(channel.guild_id ?? "");
    if (!guildId || !guilds.includes(guildId)) {
      return {
        ok: false,
        status: 403,
        error: "channel is not in this assistant's server",
        reason: "channel_in_foreign_guild",
      };
    }
    if (allowedChannelIds.has(channelRef)) {
      return { ok: true, channelId: channelRef, autoBound: false };
    }
    if (!POSTABLE_CHANNEL_TYPES.has(channel.type)) {
      return {
        ok: false,
        status: 404,
        error:
          "channel exists in this assistant's server but is not a text or announcement channel",
        reason: "channel_not_postable",
      };
    }
    return autoBind(guildId, channelRef);
  }

  const norm = normalizeChannelName(channelRef);
  const matches: Array<{ guildId: string; channel: DiscordChannel }> = [];
  let listFailures = 0;
  for (const guildId of guilds) {
    let channels: DiscordChannel[];
    try {
      channels = await deps.listGuildChannels(guildId);
    } catch (error) {
      listFailures += 1;
      deps.log?.("warn", "cron-webhook: discord api error listing channels", {
        guildId,
        channelRef,
        error: errorText(error),
      });
      continue;
    }
    for (const channel of channels) {
      if ((channel.name || "").toLowerCase() === norm) {
        matches.push({ guildId, channel });
      }
    }
  }

  const bound = matches.find((m) => allowedChannelIds.has(m.channel.id));
  if (bound) return { ok: true, channelId: bound.channel.id, autoBound: false };

  const postable = matches.filter((m) =>
    POSTABLE_CHANNEL_TYPES.has(m.channel.type),
  );
  let lastFailure: CronChannelResolution | null = null;
  for (const match of postable) {
    const result = await autoBind(match.guildId, match.channel.id);
    if (result.ok) return result;
    lastFailure = result;
  }
  if (lastFailure) return lastFailure;

  if (matches.length > 0) {
    return {
      ok: false,
      status: 404,
      error:
        "channel exists in this assistant's server but is not a text or announcement channel",
      reason: "channel_not_postable",
    };
  }
  if (listFailures > 0) {
    return {
      ok: false,
      status: 502,
      error: "discord api error while resolving the channel",
      reason: "discord_api_error",
    };
  }
  return {
    ok: false,
    status: 404,
    error: "no channel with that name in this assistant's server",
    reason: "channel_name_not_found",
  };
};

const liveCronChannelDeps: CronChannelDeps = {
  getChannel: getDiscordChannel,
  listGuildChannels: getDiscordGuildChannels,
  findEnabledChannelBinding: (guildId, channelId) =>
    DiscordAssistantBinding.findOne({
      discordGuildId: guildId,
      discordChannelId: channelId,
      enabled: true,
    })
      .select(BINDING_CONTEXT_FIELDS)
      .lean(),
  createBinding: (row) => DiscordAssistantBinding.create(row),
  log: (level, message, meta) => logger[level](message, meta),
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
    const hostRef = String(req.query.host ?? "").trim().toLowerCase();

    // Every rejection is logged with host + channel so lost cron posts are
    // countable. Never log the token.
    const reject = (
      status: number,
      error: string,
      reason: string,
      extra: Record<string, unknown> = {},
    ) => {
      logger.warn("cron-webhook: rejected", {
        status,
        reason,
        host: hostRef || undefined,
        assistantId: assistantId || undefined,
        channel: channelRef || undefined,
        ...extra,
      });
      res.status(status).json({ error });
    };

    if (!env.CRON_WEBHOOK_SECRET) {
      reject(503, "cron webhook not configured", "not_configured");
      return;
    }

    const hasScopedIdentity = Boolean(tenantId || runtimeKindValue);
    if (
      hasScopedIdentity &&
      (!tenantId ||
        (runtimeKindValue !== "openclaw" && runtimeKindValue !== "hermes"))
    ) {
      reject(400, "invalid runtime scope", "invalid_runtime_scope");
      return;
    }

    // Assistants provisioned since 2026-08 sign the cron webhook with the
    // runtime HOST rather than the erxes assistantId: the deployer does not
    // reliably know that id, but the host is the binding's stable key. Without
    // this branch every such delivery 401s, which silently dropped every
    // scheduled report between 2026-08-04 and 2026-09-10.
    let hostScopeAssistantId = "";
    if (!assistantId.trim() && hostRef) {
      const expectedHostToken = crypto
        .createHmac("sha256", env.CRON_WEBHOOK_SECRET)
        .update(hostRef)
        .digest("hex")
        .slice(0, 32);
      if (!token || !safeEqual(token, expectedHostToken)) {
        reject(401, "unauthorized", "bad_host_token");
        return;
      }
      const hostBinding = await DiscordAssistantBinding.findOne({
        openclawUrl: { $in: [`https://${hostRef}`, `https://${hostRef}/`] },
        enabled: true,
      })
        .select(BINDING_CONTEXT_FIELDS)
        .lean();
      if (!hostBinding?.assistantId) {
        reject(404, "assistant not bound", "host_not_bound");
        return;
      }
      hostScopeAssistantId = hostBinding.assistantId;
    }

    const scope: DiscordCronScope = {
      assistantId: (assistantId || hostScopeAssistantId).trim(),
      ...(hasScopedIdentity
        ? {
            tenantId,
            runtimeKind: runtimeKindValue as AssistantRuntimeKind,
          }
        : {}),
    };

    if (
      !scope.assistantId ||
      (!hostScopeAssistantId && !validateDiscordCronToken(token, scope))
    ) {
      reject(401, "unauthorized", "bad_token");
      return;
    }
    if (!channelRef) {
      reject(400, "missing channel", "missing_channel", {
        assistantId: scope.assistantId,
      });
      return;
    }

    // The guild(s) this exact assistant runtime is bound to, with enough of
    // each binding to create a new one for an unbound channel.
    const bindings = (await DiscordAssistantBinding.find(
      buildCronBindingQuery(scope),
    )
      .select(BINDING_CONTEXT_FIELDS)
      .lean()) as CronBindingRow[];
    if (!bindings.some((b) => b.discordGuildId)) {
      reject(403, "assistant has no active discord binding", "no_binding", {
        assistantId: scope.assistantId,
      });
      return;
    }

    // Resolve the channel — a numeric ID or a channel NAME, always scoped to
    // THIS assistant's own guild(s) (tenant isolation).
    const resolution = await resolveCronChannel(
      { channelRef, ownBindings: bindings },
      liveCronChannelDeps,
    );
    if (!resolution.ok) {
      reject(resolution.status, resolution.error, resolution.reason, {
        assistantId: scope.assistantId,
      });
      return;
    }
    const channelId = resolution.channelId;

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

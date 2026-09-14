import crypto from "node:crypto";
import { Router } from "express";

import { env } from "../config/env.js";
import { sendChannelMessageWithFiles } from "../discord/api.js";
import { buildRuntimeFilePayloads } from "../discord/messageGateway.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logger } from "../lib/logger.js";
import { DiscordAssistantBinding } from "../models/DiscordAssistantBinding.js";
import {
  downloadRuntimeGeneratedFile,
  type RuntimeGeneratedFile,
} from "../openclaw/client.js";

// Late turns (sub-agent results after sessions_yield) forwarded by the runtime
// adapter, authenticated with the host-signed cron webhook token it already holds.

export const FOLLOWUP_MAX_TEXT_CHARS = 12_000;
export const FOLLOWUP_CHUNK_CHARS = 1900;
export const FOLLOWUP_MAX_CHUNKS = 6;
export const FOLLOWUP_MAX_FILES = 5;

export type FollowupPayload = {
  channelId: string;
  threadId?: string;
  text: string;
  files: RuntimeGeneratedFile[];
  fileErrors: string[];
  replyToMessageId?: string;
};

const DISCORD_ID_RE = /^\d{5,25}$/;
const FILE_ID_RE = /^[a-f0-9-]{36}$/;

export const buildFollowupHostToken = (
  host: string,
  secret = env.CRON_WEBHOOK_SECRET,
): string =>
  crypto.createHmac("sha256", secret).update(host).digest("hex").slice(0, 32);

const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

export const validateFollowupHostToken = (
  token: string,
  host: string,
  secret = env.CRON_WEBHOOK_SECRET,
): boolean =>
  Boolean(token && host && secret && safeEqual(token, buildFollowupHostToken(host, secret)));

export const parseFollowupPayload = (
  body: unknown,
): { ok: true; payload: FollowupPayload } | { ok: false; error: string } => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be an object" };
  }
  const b = body as Record<string, unknown>;
  const channelId = typeof b.channelId === "string" ? b.channelId.trim() : "";
  if (!DISCORD_ID_RE.test(channelId)) return { ok: false, error: "invalid channelId" };
  const threadId =
    typeof b.threadId === "string" && DISCORD_ID_RE.test(b.threadId.trim())
      ? b.threadId.trim()
      : undefined;
  const text = typeof b.text === "string" ? b.text.trim().slice(0, FOLLOWUP_MAX_TEXT_CHARS) : "";
  const rawFiles = Array.isArray(b.files) ? b.files.slice(0, FOLLOWUP_MAX_FILES) : [];
  const files: RuntimeGeneratedFile[] = [];
  for (const item of rawFiles) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    if (typeof f.fileId !== "string" || !FILE_ID_RE.test(f.fileId)) continue;
    if (typeof f.filename !== "string" || !f.filename.trim()) continue;
    files.push({
      fileId: f.fileId,
      filename: f.filename.trim().slice(0, 100),
      contentType: typeof f.contentType === "string" ? f.contentType : "application/octet-stream",
      size: typeof f.size === "number" ? f.size : 0,
    });
  }
  const fileErrors = Array.isArray(b.fileErrors)
    ? b.fileErrors.filter((e): e is string => typeof e === "string").slice(0, 5).map((e) => e.slice(0, 200))
    : [];
  if (!text && files.length === 0) return { ok: false, error: "nothing to post" };
  const replyToMessageId =
    typeof b.replyToMessageId === "string" && DISCORD_ID_RE.test(b.replyToMessageId.trim())
      ? b.replyToMessageId.trim()
      : undefined;
  return { ok: true, payload: { channelId, threadId, text, files, fileErrors, replyToMessageId } };
};

export const chunkFollowupText = (text: string): string[] => {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > 0 && out.length < FOLLOWUP_MAX_CHUNKS) {
    if (rest.length <= FOLLOWUP_CHUNK_CHARS) {
      out.push(rest);
      rest = "";
      break;
    }
    let cut = rest.lastIndexOf("\n", FOLLOWUP_CHUNK_CHARS);
    if (cut < FOLLOWUP_CHUNK_CHARS * 0.5) cut = FOLLOWUP_CHUNK_CHARS;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0 && out.length > 0) {
    out[out.length - 1] = `${out[out.length - 1]}\n\n[truncated]`;
  }
  return out;
};

export const discordFollowupRouter = Router();

discordFollowupRouter.post(
  "/discord-followup",
  asyncHandler(async (req, res) => {
    const hostRef = String(req.query.host ?? "").trim().toLowerCase();
    const token = String(req.query.token ?? "");
    if (!env.CRON_WEBHOOK_SECRET) {
      res.status(503).json({ error: "followup webhook not configured" });
      return;
    }
    if (!hostRef || !validateFollowupHostToken(token, hostRef)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const parsed = parseFollowupPayload(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { payload } = parsed;

    const binding = await DiscordAssistantBinding.findOne({
      openclawUrl: { $in: [`https://${hostRef}`, `https://${hostRef}/`] },
      discordChannelId: payload.channelId,
      enabled: true,
    })
      .select("assistantId tenantId openclawUrl discordGuildId discordChannelId")
      .lean();
    if (!binding) {
      res.status(403).json({ error: "channel is not bound to this assistant" });
      return;
    }

    const { payloads, failed, blocked } = payload.files.length
      ? await buildRuntimeFilePayloads(binding.openclawUrl, payload.files, downloadRuntimeGeneratedFile)
      : { payloads: [], failed: [] as string[], blocked: [] as string[] };

    const notes: string[] = [];
    if (payload.fileErrors.length) notes.push(`Note: some generated files couldn't be prepared: ${payload.fileErrors.join("; ")}`);
    if (failed.length) notes.push(`Note: couldn't fetch: ${failed.join(", ")}`);
    if (blocked.length) notes.push(`Note: withheld (contains secrets): ${blocked.join(", ")}`);

    const chunks = chunkFollowupText([payload.text, ...notes].filter(Boolean).join("\n\n"));
    if (chunks.length === 0 && payloads.length > 0) chunks.push("Here is the generated file.");

    try {
      const target = payload.threadId ?? payload.channelId;
      for (let i = 0; i < chunks.length; i += 1) {
        const last = i === chunks.length - 1;
        await sendChannelMessageWithFiles(target, chunks[i]!, {
          files: last ? payloads : [],
          replyToMessageId: i === 0 ? payload.replyToMessageId : undefined,
        });
      }
      logger.info("followup-webhook: posted to channel", {
        assistantId: binding.assistantId,
        channelId: payload.channelId,
        chunks: chunks.length,
        files: payloads.length,
      });
      res.json({ ok: true, chunks: chunks.length, files: payloads.length });
    } catch (error) {
      logger.error("followup-webhook: failed to post to channel", {
        assistantId: binding.assistantId,
        channelId: payload.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({ error: "failed to post to channel" });
    }
  }),
);

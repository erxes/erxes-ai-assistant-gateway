import {
  createGuildChannel,
  getDiscordChannel,
  getDiscordGuildChannels,
  sendChannelMessage,
} from "./api.js";
import { DiscordAssistantBinding } from "../models/DiscordAssistantBinding.js";
import type { AssistantRuntimeKind } from "../runtime/identity.js";

// The model can ask the gateway to create a Discord channel by emitting a marker
// in its answer, e.g.  [discord-create-channel: project updates]
// The gateway creates the channel in the originating guild (the bot is invited
// with its managed channel permissions), strips the marker from the answer,
// and appends a short
// confirmation. Mirrors the existing [discord-file: …] delivery markers.
const CREATE_CHANNEL_MARKER_RE = /\[discord-create-channel:\s*([^\]]+?)\s*\]/gi;
const MAX_CHANNELS_PER_MESSAGE = 5;

// Discord channel names: lowercase, spaces -> dashes, restricted charset, <=100.
export const sanitizeChannelName = (raw: string): string =>
  ((raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "new-channel");

export type ChannelActionResult = { text: string; note: string };

export type ChannelBindingContext = {
  tenantId: string;
  assistantId: string;
  assistantName?: string;
  openclawUrl: string;
  runtimeKind?: AssistantRuntimeKind;
};

export const buildChannelBindingUpdate = (
  context: ChannelBindingContext,
  guildId: string,
  channelId: string,
) => ({
  tenantId: context.tenantId,
  assistantId: context.assistantId,
  assistantName: context.assistantName,
  openclawUrl: context.openclawUrl,
  runtimeKind: context.runtimeKind || "openclaw",
  discordGuildId: guildId,
  discordChannelId: channelId,
  enabled: true,
  responseMode: "all_messages" as const,
});

// A model-created channel may reuse an existing Discord channel, but it must
// never take an active binding away from another tenant or assistant. The
// filter is used with an atomic upsert so concurrent marker processing cannot
// overwrite a binding that changed ownership between lookup and update.
export const buildOwnedChannelBindingFilter = (
  context: ChannelBindingContext,
  guildId: string,
  channelId: string,
) => {
  const sameRuntime =
    context.runtimeKind === "hermes"
      ? { runtimeKind: "hermes" }
      : {
          $or: [
            { runtimeKind: "openclaw" },
            { runtimeKind: { $exists: false } },
          ],
        };

  return {
    discordGuildId: guildId,
    discordChannelId: channelId,
    $or: [
      { enabled: { $ne: true } },
      {
        tenantId: context.tenantId,
        assistantId: context.assistantId,
        ...sameRuntime,
      },
    ],
  };
};

export const buildAssistantBindingScope = (
  assistantId: string,
  context?: ChannelBindingContext,
) => {
  if (!context) {
    return { assistantId, enabled: true };
  }

  const identity = {
    tenantId: context.tenantId,
    assistantId: context.assistantId,
    enabled: true,
  };

  if (context.runtimeKind === "hermes") {
    return { ...identity, runtimeKind: "hermes" };
  }

  // Bindings created before runtimeKind was introduced are OpenClaw. Keep
  // those channels working while still excluding explicitly-Hermes rows.
  return {
    ...identity,
    $or: [
      { runtimeKind: "openclaw" },
      { runtimeKind: { $exists: false } },
    ],
  };
};

export const applyChannelCreateMarkers = async (
  answer: string,
  guildId: string | undefined,
  log?: (message: string, meta?: Record<string, unknown>) => void,
  bindingContext?: ChannelBindingContext,
): Promise<ChannelActionResult> => {
  const text = String(answer ?? "");
  const matches = [...text.matchAll(CREATE_CHANNEL_MARKER_RE)];
  if (matches.length === 0) {
    return { text, note: "" };
  }

  const stripped = text
    .replace(CREATE_CHANNEL_MARKER_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!guildId) {
    log?.("discord create-channel skipped: no guildId");
    return { text: stripped, note: "" };
  }

  // Idempotent: reuse an existing channel of the same name instead of making a
  // duplicate. (Discord allows same-named channels, so without this each run
  // piles up empty clones.)
  const existing: Array<{ id: string; name?: string }> = [];
  try {
    existing.push(...(await getDiscordGuildChannels(guildId)));
  } catch {
    /* fall back to create-only if the list fails */
  }

  const created: string[] = [];
  const reused: string[] = [];
  const failed: string[] = [];
  for (const match of matches.slice(0, MAX_CHANNELS_PER_MESSAGE)) {
    const name = sanitizeChannelName(match[1] ?? "");
    const found = existing.find((c) => (c.name || "").toLowerCase() === name);
    if (found) {
      reused.push(`<#${found.id}>`);
      log?.("discord channel reused", { guildId, name, channelId: found.id });
      if (bindingContext) {
        try {
          await DiscordAssistantBinding.findOneAndUpdate(
            buildOwnedChannelBindingFilter(bindingContext, guildId, found.id),
            {
              $set: buildChannelBindingUpdate(
                bindingContext,
                guildId,
                found.id,
              ),
            },
            { upsert: true },
          );
        } catch (bindErr) {
          log?.("discord reused channel binding skipped (non-fatal)", {
            guildId,
            name,
            channelId: found.id,
            error:
              bindErr instanceof Error ? bindErr.message : String(bindErr),
          });
        }
      }
      continue;
    }
    try {
      const channel = await createGuildChannel(guildId, name);
      created.push(`<#${channel.id}>`);
      // so a second marker with the same name this turn reuses it too
      existing.push({ id: channel.id, name });
      log?.("discord channel created", { guildId, name, channelId: channel.id });
      // Auto-register binding so this channel routes back to this assistant.
      if (bindingContext) {
        try {
          await DiscordAssistantBinding.findOneAndUpdate(
            buildOwnedChannelBindingFilter(bindingContext, guildId, channel.id),
            {
              $set: buildChannelBindingUpdate(
                bindingContext,
                guildId,
                channel.id,
              ),
            },
            { upsert: true },
          );
          log?.("discord channel binding upserted", { guildId, name, channelId: channel.id });
        } catch (bindErr) {
          log?.("discord channel binding failed (non-fatal)", {
            guildId,
            name,
            channelId: channel.id,
            error: bindErr instanceof Error ? bindErr.message : String(bindErr),
          });
        }
      }
    } catch (error) {
      failed.push(name);
      log?.("discord create-channel failed", {
        guildId,
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const parts: string[] = [];
  if (created.length > 0) {
    parts.push(
      `✅ Created channel${created.length > 1 ? "s" : ""}: ${created.join(", ")}`,
    );
  }
  if (reused.length > 0) {
    parts.push(
      `↪️ Using existing channel${reused.length > 1 ? "s" : ""}: ${reused.join(", ")}`,
    );
  }
  if (failed.length > 0) {
    parts.push(`⚠️ Couldn't create: ${failed.join(", ")}`);
  }
  return { text: stripped, note: parts.join("\n") };
};

// The model can post content INTO a specific channel (not just the one it was
// messaged from) with a block marker:
//   [discord-post-channel: <channel name or id>]
//   ...content (any length)...
//   [/discord-post-channel]
// The gateway resolves the target to a channel in THIS assistant's own guild,
// posts the content (chunked under Discord's 2000-char limit), and strips the
// block. Lets a coordinator/main agent drop each subagent's work into its channel.
const POST_CHANNEL_BLOCK_RE =
  /\[discord-post-channel:\s*([^\]\n]+?)\s*\]\s*\n?([\s\S]*?)\[\/discord-post-channel\]/gi;
const MAX_POST_CHUNKS = 12;
const POST_CHUNK_CHARS = 1900;

const chunkForDiscord = (text: string): string[] => {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > 0 && out.length < MAX_POST_CHUNKS) {
    if (rest.length <= POST_CHUNK_CHARS) {
      out.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\n", POST_CHUNK_CHARS);
    if (cut < POST_CHUNK_CHARS * 0.5) cut = POST_CHUNK_CHARS;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return out;
};

export const applyChannelPostMarkers = async (
  answer: string,
  assistantId: string,
  log?: (message: string, meta?: Record<string, unknown>) => void,
  bindingContext?: ChannelBindingContext,
): Promise<ChannelActionResult> => {
  const text = String(answer ?? "");
  const matches = [...text.matchAll(POST_CHANNEL_BLOCK_RE)];
  if (matches.length === 0) {
    return { text, note: "" };
  }

  const stripped = text
    .replace(POST_CHANNEL_BLOCK_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // The guild(s) this assistant is bound to — never post outside its own server.
  const bindings = await DiscordAssistantBinding.find(
    buildAssistantBindingScope(assistantId, bindingContext),
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
    log?.("post-channel: assistant has no active binding");
    return { text: stripped, note: "" };
  }

  const channelCache = new Map<string, Array<{ id: string; name?: string }>>();
  const listGuild = async (g: string) => {
    if (!channelCache.has(g)) {
      try {
        channelCache.set(g, await getDiscordGuildChannels(g));
      } catch {
        channelCache.set(g, []);
      }
    }
    return channelCache.get(g) as Array<{ id: string; name?: string }>;
  };
  const resolveChannel = async (target: string): Promise<string | null> => {
    const t = target.trim().replace(/^#/, "");
    if (/^\d{5,25}$/.test(t)) {
      if (!allowedChannelIds.has(t)) return null;
      try {
        const ch = await getDiscordChannel(t);
        if (ch.guild_id && guilds.includes(ch.guild_id)) return t;
      } catch {
        /* not found */
      }
      return null;
    }
    const norm = t.toLowerCase().replace(/\s+/g, "-");
    for (const g of guilds) {
      const found = (await listGuild(g)).find(
        (c) =>
          allowedChannelIds.has(c.id) &&
          (c.name || "").toLowerCase() === norm,
      );
      if (found) return found.id;
    }
    return null;
  };

  const posted: string[] = [];
  const failed: string[] = [];
  for (const m of matches) {
    const target = m[1] ?? "";
    const content = (m[2] ?? "").trim();
    if (!content) continue;
    const channelId = await resolveChannel(target);
    if (!channelId) {
      failed.push(target.trim());
      log?.("post-channel: target not found in assistant guild", { target });
      continue;
    }
    try {
      for (const chunk of chunkForDiscord(content)) {
        await sendChannelMessage(channelId, chunk);
      }
      posted.push(`<#${channelId}>`);
      log?.("post-channel: posted", { assistantId, channelId });
    } catch (error) {
      failed.push(target.trim());
      log?.("post-channel: failed", {
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const parts: string[] = [];
  if (posted.length > 0) parts.push(`✅ Posted to ${posted.join(", ")}`);
  if (failed.length > 0) parts.push(`⚠️ Couldn't post to: ${failed.join(", ")}`);
  return { text: stripped, note: parts.join("\n") };
};

import { createGuildChannel } from "./api.js";

// The model can ask the gateway to create a Discord channel by emitting a marker
// in its answer, e.g.  [discord-create-channel: project updates]
// The gateway creates the channel in the originating guild (the bot is invited
// with Administrator), strips the marker from the answer, and appends a short
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

export const applyChannelCreateMarkers = async (
  answer: string,
  guildId: string | undefined,
  log?: (message: string, meta?: Record<string, unknown>) => void,
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

  const created: string[] = [];
  const failed: string[] = [];
  for (const match of matches.slice(0, MAX_CHANNELS_PER_MESSAGE)) {
    const name = sanitizeChannelName(match[1] ?? "");
    try {
      const channel = await createGuildChannel(guildId, name);
      created.push(`<#${channel.id}>`);
      log?.("discord channel created", { guildId, name, channelId: channel.id });
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
  if (failed.length > 0) {
    parts.push(`⚠️ Couldn't create: ${failed.join(", ")}`);
  }
  return { text: stripped, note: parts.join("\n") };
};

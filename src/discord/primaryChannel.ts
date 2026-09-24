import { DiscordAssistantBinding } from "../models/DiscordAssistantBinding.js";

// The first channel an assistant was bound to in a server is the one the
// customer connected it to in erxes: its main channel. The runtime keeps that
// channel with the main agent and refuses to route it to a sub-agent, so it is
// flagged on every message (a sub-agent took over #general on 09-24 and could
// not hand it back).
type BindingKey = {
  tenantId: string;
  assistantId: string;
  discordGuildId: string;
  discordChannelId: string;
};

type FindFirstChannel = (key: Omit<BindingKey, "discordChannelId">) => Promise<string | null>;

const CACHE_MS = 60_000;
const cache = new Map<string, { channelId: string | null; at: number }>();

const findFirstChannelInDb: FindFirstChannel = async ({ tenantId, assistantId, discordGuildId }) => {
  const first = await DiscordAssistantBinding.findOne({ tenantId, assistantId, discordGuildId, enabled: true })
    .sort({ createdAt: 1, _id: 1 })
    .select("discordChannelId")
    .lean();
  return first?.discordChannelId ?? null;
};

export const isPrimaryChannelBinding = async (
  binding: BindingKey,
  findFirstChannel: FindFirstChannel = findFirstChannelInDb,
  now = Date.now(),
): Promise<boolean> => {
  const key = `${binding.tenantId}:${binding.assistantId}:${binding.discordGuildId}`;
  const hit = cache.get(key);
  let channelId: string | null;
  if (hit && now - hit.at < CACHE_MS) {
    channelId = hit.channelId;
  } else {
    try {
      channelId = await findFirstChannel(binding);
    } catch {
      return false;
    }
    cache.set(key, { channelId, at: now });
  }
  return channelId === binding.discordChannelId;
};

export const clearPrimaryChannelCache = () => cache.clear();

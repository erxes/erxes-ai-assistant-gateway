import { env, requireEnv } from "../config/env.js";
import { badRequest, forbidden, notFound, rateLimit } from "../lib/errors.js";

const DISCORD_RATE_LIMIT_MESSAGE =
  "Discord is rate limiting requests. Please wait a moment and try again.";

const parseRetryAfterSeconds = (
  payload: unknown,
  headerValue: string | null,
) => {
  if (
    payload &&
    typeof payload === "object" &&
    "retry_after" in payload &&
    typeof payload.retry_after === "number" &&
    Number.isFinite(payload.retry_after)
  ) {
    return Math.max(0, payload.retry_after);
  }

  if (!headerValue) {
    return undefined;
  }

  const numericValue = Number(headerValue);

  if (Number.isFinite(numericValue)) {
    return Math.max(0, numericValue);
  }

  const dateValue = Date.parse(headerValue);

  if (Number.isFinite(dateValue)) {
    return Math.max(0, (dateValue - Date.now()) / 1000);
  }

  return undefined;
};

export const discordApiBaseUrl = "https://discord.com/api/v10";

type DiscordFetchOptions = {
  method?: string;
  bot?: boolean;
  bearerToken?: string;
  body?: URLSearchParams | unknown;
  headers?: Record<string, string>;
};

export const discordFetch = async <T>(
  path: string,
  options: DiscordFetchOptions = {},
): Promise<T> => {
  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
  };

  if (options.bot !== false) {
    headers.Authorization = `Bot ${requireEnv("DISCORD_BOT_TOKEN")}`;
  }

  if (options.bearerToken) {
    headers.Authorization = `Bearer ${options.bearerToken}`;
  }

  let body: string | URLSearchParams | undefined;

  if (options.body instanceof URLSearchParams) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = options.body;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${discordApiBaseUrl}${path}`, {
    method: options.method ?? (body ? "POST" : "GET"),
    headers,
    body,
  });

  const text = await response.text();
  let payload: unknown;

  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }

  if (response.status === 403) {
    throw forbidden("Missing Discord permission for this guild or channel");
  }

  if (response.status === 404) {
    throw notFound("Discord guild, channel, or installation was not found");
  }

  if (response.status === 429) {
    const retryAfter = parseRetryAfterSeconds(
      payload,
      response.headers.get("Retry-After"),
    );

    throw rateLimit(DISCORD_RATE_LIMIT_MESSAGE, {
      code: "DISCORD_RATE_LIMITED",
      retryAfter,
    });
  }

  if (!response.ok) {
    throw badRequest(`Discord API request failed with status ${response.status}`);
  }

  return payload as T;
};

export type DiscordGuild = {
  id: string;
  name?: string;
};

export type DiscordChannel = {
  id: string;
  name?: string;
  type: number;
  position?: number;
  parent_id?: string;
  guild_id?: string;
};

export const getDiscordChannel = (channelId: string) =>
  discordFetch<DiscordChannel>(`/channels/${channelId}`);

export const getDiscordGuild = (guildId: string) =>
  discordFetch<DiscordGuild>(`/guilds/${guildId}`);

export const getDiscordGuildChannels = (guildId: string) =>
  discordFetch<DiscordChannel[]>(`/guilds/${guildId}/channels`);

// Create a channel in a guild. The managed install requests Manage Channels;
// type 0 = GUILD_TEXT.
export const createGuildChannel = (
  guildId: string,
  name: string,
  options: { type?: number; parentId?: string; topic?: string } = {},
) =>
  discordFetch<DiscordChannel>(`/guilds/${guildId}/channels`, {
    method: "POST",
    body: {
      name,
      type: options.type ?? 0,
      ...(options.parentId ? { parent_id: options.parentId } : {}),
      ...(options.topic ? { topic: options.topic.slice(0, 1024) } : {}),
    },
  });

// Post a plain message to a channel via the bot token. Used as a delivery
// fallback when an interaction-token follow-up is no longer usable.
export const sendChannelMessage = (channelId: string, content: string) =>
  discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: {
      content: content.slice(0, 2000),
      allowed_mentions: { parse: [] },
    },
  });

export type DiscordOAuthTokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  guild?: DiscordGuild;
};

export const exchangeDiscordOAuthCode = async (code: string) => {
  const body = new URLSearchParams({
    client_id: requireEnv("DISCORD_CLIENT_ID"),
    client_secret: requireEnv("DISCORD_CLIENT_SECRET"),
    grant_type: "authorization_code",
    code,
    redirect_uri: env.DISCORD_REDIRECT_URI,
  });

  return discordFetch<DiscordOAuthTokenResponse>("/oauth2/token", {
    method: "POST",
    bot: false,
    body,
  });
};

export type DiscordOAuthMeResponse = {
  user?: {
    id?: string;
    username?: string;
  };
  guild?: DiscordGuild;
};

export const getDiscordOAuthMe = (accessToken: string) =>
  discordFetch<DiscordOAuthMeResponse>("/oauth2/@me", {
    bot: false,
    bearerToken: accessToken,
  });

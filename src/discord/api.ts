import { env, requireEnv } from "../config/env.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";

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
};

export const getDiscordGuild = (guildId: string) =>
  discordFetch<DiscordGuild>(`/guilds/${guildId}`);

export const getDiscordGuildChannels = (guildId: string) =>
  discordFetch<DiscordChannel[]>(`/guilds/${guildId}/channels`);

export type DiscordOAuthTokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
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

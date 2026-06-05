import { env, requireEnv } from "../config/env.js";
import { discordApiBaseUrl } from "./api.js";
import { applicationCommands } from "./commands.js";

export const registerDiscordCommands = async () => {
  const applicationId = requireEnv("DISCORD_APPLICATION_ID");
  const botToken = requireEnv("DISCORD_BOT_TOKEN");

  const route = env.DISCORD_TEST_GUILD_ID
    ? `/applications/${applicationId}/guilds/${env.DISCORD_TEST_GUILD_ID}/commands`
    : `/applications/${applicationId}/commands`;

  const response = await fetch(`${discordApiBaseUrl}${route}`, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(applicationCommands),
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Discord command registration failed: ${response.status} ${body}`,
    );
  }

  return {
    scope: env.DISCORD_TEST_GUILD_ID ? "guild" : "global",
    guildId: env.DISCORD_TEST_GUILD_ID || undefined,
    commands: JSON.parse(body) as unknown,
  };
};

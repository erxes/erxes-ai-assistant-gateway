import dotenv from "dotenv";

import {
  defaultBotPermissions,
  isValidDiscordPermissionInteger,
} from "../discord/permissions.js";

dotenv.config();

const toNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: toNumber(process.env.PORT, 3001),
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? "http://localhost:3001",
  MONGO_URL:
    process.env.MONGO_URL ??
    "mongodb://127.0.0.1:27017/erxes_ai_assistant_gateway",
  DISCORD_APPLICATION_ID: process.env.DISCORD_APPLICATION_ID ?? "",
  DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY ?? "",
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN ?? "",
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID ?? "",
  DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET ?? "",
  DISCORD_REDIRECT_URI:
    process.env.DISCORD_REDIRECT_URI ??
    "http://localhost:3001/discord/oauth/callback",
  DISCORD_TEST_GUILD_ID: process.env.DISCORD_TEST_GUILD_ID ?? "",
  DISCORD_BOT_PERMISSIONS:
    process.env.DISCORD_BOT_PERMISSIONS ?? defaultBotPermissions,
  ERXES_ALLOWED_RETURN_URLS:
    process.env.ERXES_ALLOWED_RETURN_URLS ?? "http://localhost:3000",
  OPENCLAW_REQUEST_TIMEOUT_MS: toNumber(
    process.env.OPENCLAW_REQUEST_TIMEOUT_MS,
    120_000,
  ),
  ERXES_GATEWAY_ADMIN_SECRET: process.env.ERXES_GATEWAY_ADMIN_SECRET ?? "",
  ERXES_ASSISTANT_REPLY_MAX_CHARS: toNumber(
    process.env.ERXES_ASSISTANT_REPLY_MAX_CHARS,
    1800,
  ),
  OPENCLAW_SHARED_SECRET: process.env.OPENCLAW_SHARED_SECRET ?? "",
};

export const requireEnv = (name: keyof typeof env): string => {
  const value = env[name];

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};

const requiredStartupEnv: Array<keyof typeof env> = [
  "MONGO_URL",
  "PUBLIC_BASE_URL",
  "DISCORD_APPLICATION_ID",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_PUBLIC_KEY",
  "DISCORD_BOT_TOKEN",
  "DISCORD_REDIRECT_URI",
  "ERXES_GATEWAY_ADMIN_SECRET",
];

export const validateEnv = () => {
  const missing = requiredStartupEnv.filter((name) => {
    const value = env[name];
    return typeof value !== "string" || value.trim().length === 0;
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  if (!isValidDiscordPermissionInteger(env.DISCORD_BOT_PERMISSIONS)) {
    throw new Error(
      "Invalid DISCORD_BOT_PERMISSIONS: expected a decimal non-negative integer string",
    );
  }
};

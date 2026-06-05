import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import express from "express";
import type { Server } from "node:http";

import { env, validateEnv } from "../src/config/env.js";
import {
  buildDiscordInstallUrl,
  discordOAuthScopes,
  validateReturnUrl,
} from "../src/discord/oauth.js";
import {
  defaultBotPermissions,
  hasAdministratorPermission,
} from "../src/discord/permissions.js";
import { createDiscordOAuthRouter } from "../src/routes/discordOAuth.js";

const originalEnv = { ...env };

afterEach(() => {
  Object.assign(env, originalEnv);
});

const withValidEnv = () => {
  Object.assign(env, {
    NODE_ENV: "development",
    MONGO_URL: "mongodb://127.0.0.1:27017/test",
    PUBLIC_BASE_URL: "http://localhost:3001",
    DISCORD_APPLICATION_ID: "app-id",
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_PUBLIC_KEY: "public-key",
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_REDIRECT_URI: "http://localhost:3001/discord/oauth/callback",
    DISCORD_BOT_PERMISSIONS: "8",
    ENABLE_MOCK_OPENCLAW: "false",
    ERXES_GATEWAY_ADMIN_SECRET: "local-secret",
  });
};

test("default Discord bot permission is Administrator", () => {
  assert.equal(defaultBotPermissions, "8");
  assert.equal(hasAdministratorPermission(defaultBotPermissions), true);
});

test("invalid Discord permission strings fail validation", () => {
  withValidEnv();
  env.DISCORD_BOT_PERMISSIONS = "8.0";
  assert.throws(() => validateEnv(), /Invalid DISCORD_BOT_PERMISSIONS/);

  env.DISCORD_BOT_PERMISSIONS = "-8";
  assert.throws(() => validateEnv(), /Invalid DISCORD_BOT_PERMISSIONS/);
});

test("OAuth install URL contains Administrator permissions", () => {
  withValidEnv();

  const url = new URL(buildDiscordInstallUrl("state-1"));

  assert.equal(url.searchParams.get("permissions"), "8");
});

test("OAuth scopes are exactly bot and applications.commands", () => {
  withValidEnv();

  const url = new URL(buildDiscordInstallUrl("state-1"));

  assert.deepEqual([...discordOAuthScopes], ["bot", "applications.commands"]);
  assert.equal(url.searchParams.get("scope"), "bot applications.commands");
});

test("return URL allowlist accepts matching origin and path only", () => {
  env.ERXES_ALLOWED_RETURN_URLS =
    "http://localhost:3000/settings,https://admin.erxes.io";

  assert.equal(
    validateReturnUrl("http://localhost:3000/settings/automations/agents/1"),
    "http://localhost:3000/settings/automations/agents/1",
  );
  assert.equal(
    validateReturnUrl("https://admin.erxes.io/settings/automations"),
    "https://admin.erxes.io/settings/automations",
  );
  assert.equal(validateReturnUrl("http://localhost:3001/settings"), undefined);
  assert.equal(validateReturnUrl("not-a-url"), undefined);
});

type CallbackDepsOverrides = Partial<{
  exchangeDiscordOAuthCode: (code: string) => Promise<{ access_token?: string }>;
  getDiscordOAuthMe: (
    accessToken: string,
  ) => Promise<{
    user?: { id?: string; username?: string };
    guild?: { id: string; name?: string };
  }>;
  getDiscordGuild: (guildId: string) => Promise<{ id: string; name?: string }>;
}>;

const requestCallback = async (
  query: string,
  overrides: CallbackDepsOverrides = {},
) => {
  const writes: unknown[] = [];
  const app = express();
  const router = createDiscordOAuthRouter({
    OAuthStateModel: {
      create: async () => ({}),
      findOneAndUpdate: async () => ({
        tenantId: "tenant-1",
        assistantId: "assistant-1",
        erxesUserId: "user-1",
        returnUrl: "http://localhost:3000/settings/automations/agents/assistant-1",
      }),
    },
    DiscordInstallationModel: {
      findOneAndUpdate: async (_filter, update) => {
        writes.push(update);
        return { _id: { toString: () => "installation-1" } };
      },
    },
    exchangeDiscordOAuthCode:
      overrides.exchangeDiscordOAuthCode ??
      (async () => ({ access_token: "access-token" })),
    getDiscordOAuthMe:
      overrides.getDiscordOAuthMe ??
      (async () => ({
        user: { id: "discord-user-1" },
      })),
    getDiscordGuild:
      overrides.getDiscordGuild ??
      (async () => ({ id: "guild-1", name: "Guild One" })),
  });

  app.use("/discord/oauth", router);

  const server = await new Promise<Server>((resolve) => {
    const createdServer = app.listen(0, () => resolve(createdServer));
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const response = await fetch(
      `http://127.0.0.1:${address.port}/discord/oauth/callback?state=state-1${query}`,
      { redirect: "manual" },
    );

    return { response, writes };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
};

test("OAuth callback rejects missing code", async () => {
  const { response, writes } = await requestCallback("&permissions=8");
  const redirect = response.headers.get("location");

  assert.equal(response.status, 302);
  assert.equal(writes.length, 0);
  assert.ok(redirect?.includes("discordConnection=error"));
  assert.ok(redirect?.includes("message=missing-oauth-code"));
});

test("OAuth callback rejects inaccessible guild", async () => {
  const { response, writes } = await requestCallback(
    "&code=code-1&permissions=8&guild_id=guild-1",
    {
      getDiscordGuild: async () => {
        throw new Error("403");
      },
    },
  );
  const redirect = response.headers.get("location");

  assert.equal(response.status, 302);
  assert.equal(writes.length, 0);
  assert.ok(redirect?.includes("message=discord-guild-inaccessible"));
});

test("OAuth callback rejects permissions without Administrator", async () => {
  const { response, writes } = await requestCallback("&code=code-1&permissions=4");
  const redirect = response.headers.get("location");

  assert.equal(response.status, 302);
  assert.equal(writes.length, 0);
  assert.ok(redirect?.includes("message=missing-administrator-permission"));
});

test("OAuth callback rejects missing guild install details", async () => {
  const { response, writes } = await requestCallback("&code=code-1&permissions=8");
  const redirect = response.headers.get("location");

  assert.equal(response.status, 302);
  assert.equal(writes.length, 0);
  assert.ok(redirect?.includes("message=missing-discord-guild"));
});

test("OAuth callback saves connected installation after verified admin install", async () => {
  const { response, writes } = await requestCallback(
    "&code=code-1&permissions=8&guild_id=guild-1",
  );
  const redirect = response.headers.get("location");

  assert.equal(response.status, 302);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    tenantId: "tenant-1",
    assistantId: "assistant-1",
    discordGuildId: "guild-1",
    discordGuildName: "Guild One",
    installedByDiscordUserId: "discord-user-1",
    installedByErxesUserId: "user-1",
    status: "connected",
    scopes: ["bot", "applications.commands"],
    permissions: "8",
  });
  assert.ok(redirect?.includes("discordConnection=success"));
});

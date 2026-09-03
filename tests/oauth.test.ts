import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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
  hasRequiredBotPermissions,
} from "../src/discord/permissions.js";
import {
  createDiscordOAuthRouter,
  validateOAuthStartSignature,
} from "../src/routes/discordOAuth.js";

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
    DISCORD_BOT_PERMISSIONS: defaultBotPermissions,
    ENABLE_MOCK_OPENCLAW: "false",
    ERXES_GATEWAY_ADMIN_SECRET: "local-secret",
  });
};

test("default Discord bot permissions are least-privilege and retain legacy Administrator compatibility", () => {
  assert.equal(defaultBotPermissions, "274878024720");
  assert.equal(hasRequiredBotPermissions(defaultBotPermissions), true);
  assert.equal(hasAdministratorPermission(defaultBotPermissions), false);
  assert.equal(hasRequiredBotPermissions("8"), true);
});

test("invalid Discord permission strings fail validation", () => {
  withValidEnv();
  env.DISCORD_BOT_PERMISSIONS = "8.0";
  assert.throws(() => validateEnv(), /Invalid DISCORD_BOT_PERMISSIONS/);

  env.DISCORD_BOT_PERMISSIONS = "-8";
  assert.throws(() => validateEnv(), /Invalid DISCORD_BOT_PERMISSIONS/);

  env.DISCORD_BOT_PERMISSIONS = "4";
  assert.throws(() => validateEnv(), /required channel and message permissions/);
});

test("OAuth install URL contains required Discord install parameters", () => {
  withValidEnv();

  const url = new URL(buildDiscordInstallUrl("state-1"));

  assert.deepEqual([...discordOAuthScopes], ["bot", "applications.commands"]);
  assert.equal(url.searchParams.get("scope"), "bot applications.commands");
  assert.equal(url.searchParams.get("permissions"), defaultBotPermissions);
  assert.equal(url.searchParams.get("integration_type"), "0");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "http://localhost:3001/discord/oauth/callback",
  );
  assert.equal(url.searchParams.get("state"), "state-1");
});

const withReturnUrlEnv = (overrides: {
  urls?: string;
  secureSuffixes?: string;
  insecureSuffixes?: string;
}) => {
  Object.assign(env, {
    ERXES_ALLOWED_RETURN_URLS: overrides.urls ?? "",
    ERXES_ALLOWED_RETURN_HOST_SUFFIXES: overrides.secureSuffixes ?? "",
    ERXES_ALLOWED_RETURN_INSECURE_HOST_SUFFIXES:
      overrides.insecureSuffixes ?? "",
  });
};

test("return URL allowlist accepts any path on an exact allowed origin", () => {
  withReturnUrlEnv({
    urls: "http://localhost:3000,https://admin.erxes.io",
  });

  // Exact origin match allows any path under that origin.
  assert.equal(
    validateReturnUrl("https://admin.erxes.io"),
    "https://admin.erxes.io/",
  );
  assert.equal(
    validateReturnUrl("https://admin.erxes.io/settings/automations"),
    "https://admin.erxes.io/settings/automations",
  );

  // A different origin (not localhost, not in allowlist, no suffix) is blocked.
  assert.equal(
    validateReturnUrl("https://other.example.com/settings"),
    undefined,
  );
  assert.equal(validateReturnUrl("not-a-url"), undefined);
});

test("return URL allows HTTPS subdomains matching an allowed host suffix", () => {
  withReturnUrlEnv({
    urls: "https://enterprise.erxes.io,https://officenext.erxes.io",
    secureSuffixes: ".erxes.io",
  });

  assert.equal(
    validateReturnUrl("https://enterprise.erxes.io/agent/assistant"),
    "https://enterprise.erxes.io/agent/assistant",
  );
  assert.equal(
    validateReturnUrl("https://officenext.erxes.io/agent/assistant"),
    "https://officenext.erxes.io/agent/assistant",
  );
  assert.equal(
    validateReturnUrl("https://abc.erxes.io/anything"),
    "https://abc.erxes.io/anything",
  );
});

test("return URL allows HTTP subdomains only when insecure suffix is enabled", () => {
  withReturnUrlEnv({
    secureSuffixes: ".erxes.io",
    insecureSuffixes: ".erxes.io",
  });

  assert.equal(
    validateReturnUrl("http://abc.erxes.io/agent/assistant"),
    "http://abc.erxes.io/agent/assistant",
  );

  // Without the insecure suffix env, the same HTTP URL is blocked.
  withReturnUrlEnv({ secureSuffixes: ".erxes.io" });
  assert.equal(
    validateReturnUrl("http://abc.erxes.io/agent/assistant"),
    undefined,
  );
});

test("return URL blocks look-alike and nested evil hosts", () => {
  withReturnUrlEnv({
    urls: "https://enterprise.erxes.io",
    secureSuffixes: ".erxes.io",
    insecureSuffixes: ".erxes.io",
  });

  // No dot boundary: "evil-erxes.io" must not match the ".erxes.io" suffix.
  assert.equal(
    validateReturnUrl("https://evil-erxes.io/agent/assistant"),
    undefined,
  );
  assert.equal(
    validateReturnUrl("http://evil-erxes.io/agent/assistant"),
    undefined,
  );

  // Suffix not at the end: "abc.erxes.io.evil.com" must not match.
  assert.equal(
    validateReturnUrl("https://abc.erxes.io.evil.com/agent/assistant"),
    undefined,
  );
  assert.equal(
    validateReturnUrl("http://abc.erxes.io.evil.com/agent/assistant"),
    undefined,
  );

  // Arbitrary domains with no allowlist/suffix entry stay blocked.
  assert.equal(
    validateReturnUrl("https://attacker.example.com/agent/assistant"),
    undefined,
  );
  assert.equal(validateReturnUrl("not-a-url"), undefined);
});

test("return URL always allows localhost and 127.0.0.1 for local dev", () => {
  withReturnUrlEnv({});

  assert.equal(
    validateReturnUrl("http://localhost:3000/agent/assistant"),
    "http://localhost:3000/agent/assistant",
  );
  assert.equal(
    validateReturnUrl("http://127.0.0.1:3000/agent/assistant"),
    "http://127.0.0.1:3000/agent/assistant",
  );
});

type CallbackDepsOverrides = Partial<{
  exchangeDiscordOAuthCode: (code: string) => Promise<{
    access_token?: string;
    guild?: { id: string; name?: string };
  }>;
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
      (async () => ({
        access_token: "access-token",
        guild: { id: "guild-1", name: "Guild One" },
      })),
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

test("OAuth callback rejects permissions missing the required bot capabilities", async () => {
  const { response, writes } = await requestCallback("&code=code-1&permissions=4");
  const redirect = response.headers.get("location");

  assert.equal(response.status, 302);
  assert.equal(writes.length, 0);
  assert.ok(redirect?.includes("message=missing-required-bot-permissions"));
});

test("OAuth callback rejects missing guild install details", async () => {
  const { response, writes } = await requestCallback(
    "&code=code-1&permissions=8",
    { exchangeDiscordOAuthCode: async () => ({ access_token: "access-token" }) },
  );
  const redirect = response.headers.get("location");

  assert.equal(response.status, 302);
  assert.equal(writes.length, 0);
  assert.ok(redirect?.includes("message=missing-discord-guild"));
});

test("OAuth callback rejects a guild hint that differs from the token response", async () => {
  const { response, writes } = await requestCallback(
    "&code=code-1&permissions=8&guild_id=other-guild",
  );
  const redirect = response.headers.get("location");

  assert.equal(response.status, 302);
  assert.equal(writes.length, 0);
  assert.ok(redirect?.includes("message=discord-guild-mismatch"));
});

test("OAuth start claims require a valid short-lived server signature", () => {
  const claims = {
    tenantId: "tenant-1",
    assistantId: "assistant-1",
    erxesUserId: "user-1",
    returnUrl: "http://localhost:3000/agent/hermes/assistant-1",
    expiresAt: String(Math.floor(Date.now() / 1000) + 600),
  };
  const signature = createHmac("sha256", "local-secret")
    .update(Object.values(claims).join("\n"))
    .digest("hex");

  assert.equal(
    validateOAuthStartSignature(claims, signature, "local-secret"),
    true,
  );
  assert.equal(
    validateOAuthStartSignature(
      { ...claims, tenantId: "another-tenant" },
      signature,
      "local-secret",
    ),
    false,
  );
});

test("OAuth callback saves connected installation after least-privilege install", async () => {
  const { response, writes } = await requestCallback(
    `&code=code-1&permissions=${defaultBotPermissions}&guild_id=guild-1`,
  );
  const redirect = response.headers.get("location");

  assert.equal(response.status, 302);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    $set: {
      tenantId: "tenant-1",
      discordGuildId: "guild-1",
      discordGuildName: "Guild One",
      installedByDiscordUserId: "discord-user-1",
      installedByErxesUserId: "user-1",
      status: "connected",
      scopes: ["bot", "applications.commands"],
      permissions: defaultBotPermissions,
    },
    $unset: { assistantId: 1 },
  });
  assert.ok(redirect?.includes("discordConnection=success"));
});

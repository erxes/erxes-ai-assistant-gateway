import assert from "node:assert/strict";
import { test } from "node:test";

import type { DiscordChannel } from "../src/discord/api.js";
import { HttpError } from "../src/lib/errors.js";
import {
  buildCronBindingQuery,
  buildDiscordCronToken,
  resolveCronChannel,
  validateDiscordCronToken,
  type CronBindingRow,
  type CronChannelDeps,
} from "../src/routes/cronWebhook.js";

const secret = "synthetic-discord-cron-secret";
const hermesScope = {
  tenantId: "tenant-1",
  assistantId: "assistant-1",
  runtimeKind: "hermes" as const,
};

test("Hermes cron tokens bind tenant, assistant, and runtime kind", () => {
  const token = buildDiscordCronToken(hermesScope, secret);

  assert.match(token, /^[a-f0-9]{32}$/);
  assert.equal(validateDiscordCronToken(token, hermesScope, secret), true);
  assert.equal(
    validateDiscordCronToken(
      token,
      { ...hermesScope, tenantId: "tenant-2" },
      secret,
    ),
    false,
  );
  assert.equal(
    validateDiscordCronToken(
      token,
      { ...hermesScope, runtimeKind: "openclaw" },
      secret,
    ),
    false,
  );
});

test("Hermes cron binding lookup uses the complete runtime identity", () => {
  assert.deepEqual(buildCronBindingQuery(hermesScope), {
    tenantId: "tenant-1",
    assistantId: "assistant-1",
    runtimeKind: "hermes",
    enabled: true,
  });
});

test("legacy OpenClaw tokens cannot select Hermes bindings", () => {
  const legacyScope = { assistantId: "assistant-1" };
  const legacyToken = buildDiscordCronToken(legacyScope, secret);

  assert.equal(
    validateDiscordCronToken(legacyToken, legacyScope, secret),
    true,
  );
  assert.deepEqual(buildCronBindingQuery(legacyScope), {
    assistantId: "assistant-1",
    enabled: true,
    $or: [
      { runtimeKind: "openclaw" },
      { runtimeKind: { $exists: false } },
    ],
  });
});

test("scoped OpenClaw cron lookup still includes pre-runtimeKind bindings", () => {
  assert.deepEqual(
    buildCronBindingQuery({
      tenantId: "tenant-1",
      assistantId: "assistant-1",
      runtimeKind: "openclaw",
    }),
    {
      tenantId: "tenant-1",
      assistantId: "assistant-1",
      enabled: true,
      $or: [
        { runtimeKind: "openclaw" },
        { runtimeKind: { $exists: false } },
      ],
    },
  );
});

test("empty secrets or tokens never authenticate", () => {
  const token = buildDiscordCronToken(hermesScope, secret);

  assert.equal(validateDiscordCronToken("", hermesScope, secret), false);
  assert.equal(validateDiscordCronToken(token, hermesScope, ""), false);
});

const ownBindings: CronBindingRow[] = [
  {
    tenantId: "tenant-1",
    assistantId: "assistant-1",
    assistantName: "Ops",
    discordGuildId: "111111",
    discordChannelId: "200001",
    openclawUrl: "https://ops.example.com",
    runtimeKind: "openclaw",
  },
];

const guildChannels: Record<string, DiscordChannel[]> = {
  "111111": [
    { id: "200001", name: "general", type: 0, guild_id: "111111" },
    { id: "200002", name: "daily-report", type: 0, guild_id: "111111" },
    { id: "200003", name: "news", type: 5, guild_id: "111111" },
    { id: "200004", name: "voice-room", type: 2, guild_id: "111111" },
    { id: "200005", name: "taken", type: 0, guild_id: "111111" },
  ],
  "999999": [{ id: "900001", name: "daily-report", type: 0, guild_id: "999999" }],
};

const makeDeps = (
  overrides: Partial<CronChannelDeps> & {
    bindings?: Map<string, CronBindingRow>;
  } = {},
) => {
  const bindings =
    overrides.bindings ??
    new Map<string, CronBindingRow>([
      [
        "111111:200005",
        { tenantId: "tenant-2", assistantId: "assistant-2", discordGuildId: "111111", discordChannelId: "200005" },
      ],
    ]);
  const created: Array<Record<string, unknown>> = [];
  const deps: CronChannelDeps = {
    getChannel: async (id) => {
      for (const list of Object.values(guildChannels)) {
        const found = list.find((c) => c.id === id);
        if (found) return found;
      }
      throw new HttpError(404, "Discord guild, channel, or installation was not found");
    },
    listGuildChannels: async (guildId) => guildChannels[guildId] ?? [],
    findEnabledChannelBinding: async (g, c) => bindings.get(`${g}:${c}`) ?? null,
    createBinding: async (row) => {
      created.push(row as Record<string, unknown>);
      bindings.set(`${row.discordGuildId}:${row.discordChannelId}`, row);
    },
    ...overrides,
  };
  return { deps, created, bindings };
};

test("cron channel: a bound channel resolves by name and by id without binding", async () => {
  const { deps, created } = makeDeps();
  assert.deepEqual(
    await resolveCronChannel({ channelRef: "General", ownBindings }, deps),
    { ok: true, channelId: "200001", autoBound: false },
  );
  assert.deepEqual(
    await resolveCronChannel({ channelRef: "200001", ownBindings }, deps),
    { ok: true, channelId: "200001", autoBound: false },
  );
  assert.equal(created.length, 0);
});

test("cron channel: an unbound text channel in the assistant's guild is auto-bound slash_only", async () => {
  const { deps, created } = makeDeps();
  const result = await resolveCronChannel(
    { channelRef: "daily report", ownBindings },
    deps,
  );
  assert.deepEqual(result, { ok: true, channelId: "200002", autoBound: true });
  assert.deepEqual(created, [
    {
      tenantId: "tenant-1",
      assistantId: "assistant-1",
      assistantName: "Ops",
      openclawUrl: "https://ops.example.com",
      runtimeKind: "openclaw",
      discordGuildId: "111111",
      discordChannelId: "200002",
      enabled: true,
      responseMode: "slash_only",
    },
  ]);
});

test("cron channel: announcement channels and numeric ids auto-bind too", async () => {
  const { deps, created } = makeDeps();
  assert.equal(
    (await resolveCronChannel({ channelRef: "news", ownBindings }, deps)).ok,
    true,
  );
  assert.deepEqual(
    await resolveCronChannel({ channelRef: "200002", ownBindings }, deps),
    { ok: true, channelId: "200002", autoBound: true },
  );
  assert.deepEqual(
    created.map((row) => row.discordChannelId),
    ["200003", "200002"],
  );
});

test("cron channel: a channel owned by another assistant is refused, never taken over", async () => {
  const { deps, created } = makeDeps();
  for (const channelRef of ["taken", "200005"]) {
    const result = await resolveCronChannel({ channelRef, ownBindings }, deps);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 403);
    assert.equal(!result.ok && result.error, "channel is bound to another assistant");
  }
  assert.equal(created.length, 0);
});

test("cron channel: a channel id in a foreign guild is refused", async () => {
  const { deps, created } = makeDeps();
  const result = await resolveCronChannel({ channelRef: "900001", ownBindings }, deps);
  assert.equal(!result.ok && result.status, 403);
  assert.equal(!result.ok && result.reason, "channel_in_foreign_guild");
  assert.equal(created.length, 0);
});

test("cron channel: 404 says whether the channel exists", async () => {
  const { deps } = makeDeps();
  const missingName = await resolveCronChannel({ channelRef: "nope", ownBindings }, deps);
  assert.equal(!missingName.ok && missingName.status, 404);
  assert.match(!missingName.ok ? missingName.error : "", /^no channel/);

  const missingId = await resolveCronChannel({ channelRef: "12345678", ownBindings }, deps);
  assert.equal(!missingId.ok && missingId.status, 404);
  assert.match(!missingId.ok ? missingId.error : "", /^no such channel/);

  const voice = await resolveCronChannel({ channelRef: "voice-room", ownBindings }, deps);
  assert.equal(!voice.ok && voice.status, 404);
  assert.match(!voice.ok ? voice.error : "", /exists .* not a text/);
});

test("cron channel: discord API failures are 502, not 404", async () => {
  const broken = new HttpError(403, "Missing Discord permission for this guild or channel");
  const { deps } = makeDeps({
    getChannel: async () => {
      throw broken;
    },
    listGuildChannels: async () => {
      throw new HttpError(429, "rate limited");
    },
  });
  const byName = await resolveCronChannel({ channelRef: "daily-report", ownBindings }, deps);
  assert.equal(!byName.ok && byName.status, 502);
  const byId = await resolveCronChannel({ channelRef: "200001", ownBindings }, deps);
  assert.equal(!byId.ok && byId.status, 502);
});

test("cron channel: a duplicate-key race re-reads the winner", async () => {
  const bindings = new Map<string, CronBindingRow>();
  const duplicate = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });

  const own = makeDeps({
    bindings,
    createBinding: async (row) => {
      bindings.set(`${row.discordGuildId}:${row.discordChannelId}`, row);
      throw duplicate;
    },
  });
  assert.deepEqual(
    await resolveCronChannel({ channelRef: "daily-report", ownBindings }, own.deps),
    { ok: true, channelId: "200002", autoBound: false },
  );

  const other = makeDeps({
    bindings: new Map(),
    createBinding: async (row) => {
      other.bindings.set(`${row.discordGuildId}:${row.discordChannelId}`, {
        tenantId: "tenant-2",
        assistantId: "assistant-2",
      });
      throw duplicate;
    },
  });
  const lost = await resolveCronChannel({ channelRef: "daily-report", ownBindings }, other.deps);
  assert.equal(!lost.ok && lost.status, 403);

  const failing = makeDeps({
    bindings: new Map(),
    createBinding: async () => {
      throw new Error("mongo down");
    },
  });
  await assert.rejects(
    resolveCronChannel({ channelRef: "daily-report", ownBindings }, failing.deps),
    /mongo down/,
  );
});

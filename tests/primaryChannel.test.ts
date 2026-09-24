import assert from "node:assert/strict";
import test from "node:test";
import { clearPrimaryChannelCache, isPrimaryChannelBinding } from "../src/discord/primaryChannel.js";

const key = { tenantId: "t", assistantId: "a", discordGuildId: "g" };

test("the assistant's first binding in a server is its primary channel; later ones are not", async () => {
  clearPrimaryChannelCache();
  const first = async () => "111";
  assert.equal(await isPrimaryChannelBinding({ ...key, discordChannelId: "111" }, first, 1000), true);
  assert.equal(await isPrimaryChannelBinding({ ...key, discordChannelId: "222" }, first, 1000), false);
});

test("the lookup is cached per assistant and server for a minute, and a failed lookup is never primary", async () => {
  clearPrimaryChannelCache();
  let calls = 0;
  const first = async () => { calls += 1; return "111"; };
  await isPrimaryChannelBinding({ ...key, discordChannelId: "111" }, first, 1000);
  await isPrimaryChannelBinding({ ...key, discordChannelId: "111" }, first, 30_000);
  assert.equal(calls, 1);
  await isPrimaryChannelBinding({ ...key, discordChannelId: "111" }, first, 70_000);
  assert.equal(calls, 2);
  clearPrimaryChannelCache();
  assert.equal(await isPrimaryChannelBinding({ ...key, discordChannelId: "111" }, async () => { throw new Error("db down"); }), false);
});

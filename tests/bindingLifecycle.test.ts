import assert from "node:assert/strict";
import { test } from "node:test";

import {
  guildsNeedingInstallation,
  normalizeRuntimeUrl,
  runtimeUrlVariants,
} from "../src/discord/bindingLifecycle.js";

test("normalizeRuntimeUrl trims whitespace and trailing slashes", () => {
  assert.equal(
    normalizeRuntimeUrl("  https://a.assistant.erxes.io/  "),
    "https://a.assistant.erxes.io",
  );
  assert.equal(
    normalizeRuntimeUrl("https://a.assistant.erxes.io///"),
    "https://a.assistant.erxes.io",
  );
  assert.equal(normalizeRuntimeUrl("   "), "");
});

test("runtimeUrlVariants matches both stored spellings of the same runtime", () => {
  assert.deepEqual(runtimeUrlVariants("https://a.assistant.erxes.io/"), [
    "https://a.assistant.erxes.io",
    "https://a.assistant.erxes.io/",
  ]);
  assert.deepEqual(runtimeUrlVariants(""), []);
  assert.deepEqual(runtimeUrlVariants("  "), []);
});

test("guildsNeedingInstallation lists guilds the target tenant cannot yet manage", () => {
  const bindings = [
    { discordGuildId: "g1" },
    { discordGuildId: "g1" },
    { discordGuildId: "g2" },
    { discordGuildId: "g3" },
  ];
  const targetInstallations = [
    { discordGuildId: "g2", status: "connected" },
    // Revoked coverage does not count — the tenant cannot manage through it.
    { discordGuildId: "g3", status: "revoked" },
  ];

  assert.deepEqual(guildsNeedingInstallation(bindings, targetInstallations), [
    "g1",
    "g3",
  ]);
});

test("guildsNeedingInstallation is empty when the target tenant covers every guild", () => {
  const bindings = [{ discordGuildId: "g1" }];
  const targetInstallations = [{ discordGuildId: "g1", status: "connected" }];

  assert.deepEqual(guildsNeedingInstallation(bindings, targetInstallations), []);
});

test("guildsNeedingInstallation with no bindings needs nothing", () => {
  assert.deepEqual(
    guildsNeedingInstallation([], [{ discordGuildId: "g1", status: "connected" }]),
    [],
  );
});

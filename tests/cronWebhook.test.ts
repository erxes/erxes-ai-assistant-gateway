import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCronBindingQuery,
  buildDiscordCronToken,
  validateDiscordCronToken,
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

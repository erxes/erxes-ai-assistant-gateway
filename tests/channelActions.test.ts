import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAssistantBindingScope,
  buildOwnedChannelBindingFilter,
  buildChannelBindingUpdate,
} from "../src/discord/channelActions.js";

const hermesContext = {
  tenantId: "tenant-1",
  assistantId: "hermes-1",
  assistantName: "Support Hermes",
  openclawUrl: "https://support-hermes.hermes.erxes.io",
  runtimeKind: "hermes" as const,
};

test("Hermes-created Discord channels keep the Hermes runtime identity", () => {
  assert.deepEqual(
    buildChannelBindingUpdate(hermesContext, "guild-1", "channel-2"),
    {
      tenantId: "tenant-1",
      assistantId: "hermes-1",
      assistantName: "Support Hermes",
      openclawUrl: "https://support-hermes.hermes.erxes.io",
      runtimeKind: "hermes",
      discordGuildId: "guild-1",
      discordChannelId: "channel-2",
      enabled: true,
      responseMode: "all_messages",
    },
  );
});

test("OpenClaw-created Discord channels retain the compatibility default", () => {
  assert.equal(
    buildChannelBindingUpdate(
      {
        tenantId: "tenant-1",
        assistantId: "openclaw-1",
        openclawUrl: "https://openclaw.example.com",
      },
      "guild-1",
      "channel-2",
    ).runtimeKind,
    "openclaw",
  );
});

test("a Hermes channel upsert cannot replace another active binding", () => {
  assert.deepEqual(
    buildOwnedChannelBindingFilter(hermesContext, "guild-1", "channel-2"),
    {
      discordGuildId: "guild-1",
      discordChannelId: "channel-2",
      $or: [
        { enabled: { $ne: true } },
        {
          tenantId: "tenant-1",
          assistantId: "hermes-1",
          runtimeKind: "hermes",
        },
      ],
    },
  );
});

test("an OpenClaw channel upsert can reuse its own legacy binding", () => {
  assert.deepEqual(
    buildOwnedChannelBindingFilter(
      {
        tenantId: "tenant-1",
        assistantId: "openclaw-1",
        openclawUrl: "https://openclaw.example.com",
      },
      "guild-1",
      "channel-2",
    ),
    {
      discordGuildId: "guild-1",
      discordChannelId: "channel-2",
      $or: [
        { enabled: { $ne: true } },
        {
          tenantId: "tenant-1",
          assistantId: "openclaw-1",
          $or: [
            { runtimeKind: "openclaw" },
            { runtimeKind: { $exists: false } },
          ],
        },
      ],
    },
  );
});

test("cross-channel actions are scoped to the Hermes tenant and runtime kind", () => {
  assert.deepEqual(buildAssistantBindingScope("ignored", hermesContext), {
    tenantId: "tenant-1",
    assistantId: "hermes-1",
    runtimeKind: "hermes",
    enabled: true,
  });
});

test("OpenClaw cross-channel scope includes legacy bindings without runtimeKind", () => {
  assert.deepEqual(
    buildAssistantBindingScope("openclaw-1", {
      tenantId: "tenant-1",
      assistantId: "openclaw-1",
      openclawUrl: "https://openclaw.example.com",
    }),
    {
      tenantId: "tenant-1",
      assistantId: "openclaw-1",
      enabled: true,
      $or: [
        { runtimeKind: "openclaw" },
        { runtimeKind: { $exists: false } },
      ],
    },
  );
});

test("legacy callers retain assistant-only cross-channel scope", () => {
  assert.deepEqual(buildAssistantBindingScope("openclaw-1"), {
    assistantId: "openclaw-1",
    enabled: true,
  });
});

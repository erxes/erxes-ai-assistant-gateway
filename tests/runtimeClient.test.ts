import assert from "node:assert/strict";
import { test } from "node:test";

import { env } from "../src/config/env.js";
import {
  askOpenClawAssistant,
  downloadRuntimeGeneratedFile,
  getOpenClawAssistantJob,
  startOpenClawAssistantJob,
} from "../src/openclaw/client.js";
import { verifyRuntimeIdentitySignature } from "../src/runtime/identity.js";

test("every Hermes runtime operation carries a signed isolated identity", async () => {
  const originalFetch = globalThis.fetch;
  const originalSecret = env.OPENCLAW_SHARED_SECRET;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const sharedSecret = "synthetic-hermes-runtime-secret";
  const identity = {
    tenantId: "tenant-1",
    assistantId: "hermes-1",
    runtimeKind: "hermes" as const,
  };

  env.OPENCLAW_SHARED_SECRET = sharedSecret;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/api/erxes-ai-assistant/ask")) {
      return new Response(JSON.stringify({ answer: "hello" }));
    }

    if (url.endsWith("/api/erxes-ai-assistant/ask-async")) {
      return new Response(JSON.stringify({ id: "job-1", status: "running" }));
    }

    if (url.endsWith("/api/erxes-ai-assistant/jobs/job-1")) {
      return new Response(JSON.stringify({ id: "job-1", status: "ready" }));
    }

    return new Response(new Uint8Array([1, 2, 3]));
  }) as typeof fetch;

  try {
    const input = {
      openclawUrl: "https://hermes.example.com/",
      ...identity,
      question: "hello",
      user: { id: "discord-user-1", username: "Discord User" },
      discord: { guildId: "guild-1", channelId: "channel-1" },
    };

    await askOpenClawAssistant(input);
    await startOpenClawAssistantJob({ ...input, jobKey: "job-key-1" });
    await getOpenClawAssistantJob(
      input.openclawUrl,
      "job-1",
      identity,
    );
    await downloadRuntimeGeneratedFile(
      input.openclawUrl,
      "12345678-1234-1234-1234-123456789abc",
      identity,
    );
  } finally {
    globalThis.fetch = originalFetch;
    env.OPENCLAW_SHARED_SECRET = originalSecret;
  }

  assert.equal(calls.length, 4);

  for (const call of calls) {
    const url = new URL(call.url);
    const headers = new Headers(call.init?.headers);
    const timestamp = headers.get("x-erxes-runtime-timestamp") || "";
    const signature = headers.get("x-erxes-runtime-signature") || "";

    assert.equal(headers.get("x-erxes-tenant-id"), identity.tenantId);
    assert.equal(headers.get("x-erxes-assistant-id"), identity.assistantId);
    assert.equal(headers.get("x-erxes-runtime-kind"), "hermes");
    assert.equal(
      verifyRuntimeIdentitySignature({
        identity,
        method: call.init?.method || "GET",
        path: url.pathname,
        sharedSecret,
        timestamp,
        signature,
      }),
      true,
    );
  }
});

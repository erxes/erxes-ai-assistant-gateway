import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { discordFetch } from "../src/discord/api.js";
import { env } from "../src/config/env.js";
import { HttpError } from "../src/lib/errors.js";
import { ShortCache } from "../src/lib/shortCache.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("Discord 429 returns sanitized rate-limit metadata", async () => {
  env.DISCORD_BOT_TOKEN = "test-token";
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ retry_after: 2.5 }), {
      status: 429,
      headers: { "Retry-After": "7" },
    });

  await assert.rejects(
    () => discordFetch("/guilds/guild-1/channels"),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 429);
      assert.equal(
        error.message,
        "Discord is rate limiting requests. Please wait a moment and try again.",
      );
      assert.deepEqual(error.details, {
        code: "DISCORD_RATE_LIMITED",
        retryAfter: 2.5,
      });

      return true;
    },
  );
});

test("Discord successful channel request still returns JSON payload", async () => {
  env.DISCORD_BOT_TOKEN = "test-token";
  globalThis.fetch = async () =>
    new Response(JSON.stringify([{ id: "channel-1", name: "general" }]), {
      status: 200,
    });

  const payload = await discordFetch<Array<{ id: string; name: string }>>(
    "/guilds/guild-1/channels",
  );

  assert.deepEqual(payload, [{ id: "channel-1", name: "general" }]);
});

test("short cache coalesces simultaneous identical loads", async () => {
  const cache = new ShortCache<string>(60_000);
  let loads = 0;

  const loader = async () => {
    loads += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return "channels";
  };

  const [first, second] = await Promise.all([
    cache.getOrLoad("installation-1:guild-1", loader),
    cache.getOrLoad("installation-1:guild-1", loader),
  ]);
  const third = await cache.getOrLoad("installation-1:guild-1", loader);

  assert.equal(first, "channels");
  assert.equal(second, "channels");
  assert.equal(third, "channels");
  assert.equal(loads, 1);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRuntimeIdentityHeaders,
  verifyRuntimeIdentitySignature,
} from "../src/runtime/identity.js";

const input = {
  identity: {
    tenantId: "tenant-1",
    assistantId: "hermes-1",
    runtimeKind: "hermes" as const,
  },
  method: "POST",
  path: "/api/erxes-ai-assistant/ask",
  sharedSecret: "synthetic-shared-secret-for-tests",
  timestamp: 1_780_000_000_000,
};

test("runtime identity headers bind tenant, assistant, kind, method, and path", () => {
  const headers = buildRuntimeIdentityHeaders(input);

  assert.equal(headers["x-erxes-tenant-id"], "tenant-1");
  assert.equal(headers["x-erxes-assistant-id"], "hermes-1");
  assert.equal(headers["x-erxes-runtime-kind"], "hermes");
  assert.equal(headers["x-erxes-runtime-timestamp"], String(input.timestamp));
  assert.match(headers["x-erxes-runtime-signature"], /^[a-f0-9]{64}$/);
  assert.equal(
    verifyRuntimeIdentitySignature({
      ...input,
      timestamp: String(input.timestamp),
      signature: headers["x-erxes-runtime-signature"],
      now: input.timestamp,
    }),
    true,
  );
});

test("a signed request cannot be replayed for another Hermes identity", () => {
  const headers = buildRuntimeIdentityHeaders(input);

  assert.equal(
    verifyRuntimeIdentitySignature({
      ...input,
      identity: { ...input.identity, assistantId: "hermes-2" },
      timestamp: String(input.timestamp),
      signature: headers["x-erxes-runtime-signature"],
      now: input.timestamp,
    }),
    false,
  );
});

test("stale runtime identity signatures are rejected", () => {
  const headers = buildRuntimeIdentityHeaders(input);

  assert.equal(
    verifyRuntimeIdentitySignature({
      ...input,
      timestamp: String(input.timestamp),
      signature: headers["x-erxes-runtime-signature"],
      now: input.timestamp + 60_001,
    }),
    false,
  );
});

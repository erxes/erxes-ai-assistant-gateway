import assert from "node:assert/strict";
import { test } from "node:test";

import { serverNameFromRuntimeUrl } from "../src/openclaw/wake.js";

test("serverNameFromRuntimeUrl extracts the assistant namespace", () => {
  assert.equal(
    serverNameFromRuntimeUrl("https://assistant-purify-test.assistant.erxes.io"),
    "assistant-purify-test",
  );
  assert.equal(
    serverNameFromRuntimeUrl("https://assistant-x.assistant.erxes.io/"),
    "assistant-x",
  );
});

test("serverNameFromRuntimeUrl rejects anything that is not an assistant host", () => {
  assert.equal(serverNameFromRuntimeUrl("https://deployer.erxes.io"), null);
  assert.equal(serverNameFromRuntimeUrl("not a url"), null);
});

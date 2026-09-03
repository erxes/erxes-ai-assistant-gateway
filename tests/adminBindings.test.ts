import assert from "node:assert/strict";
import test from "node:test";

import { validateRuntimeUrl } from "../src/routes/adminBindings.js";

test("runtime URL normalization removes trailing slashes in linear time", () => {
  assert.equal(
    validateRuntimeUrl(
      `https://runtime.example.com${"/".repeat(10_000)}`,
      "hermes",
    ),
    "https://runtime.example.com",
  );
});

test("runtime URL normalization preserves non-trailing path slashes", () => {
  assert.equal(
    validateRuntimeUrl("https://runtime.example.com/api/chat///", "hermes"),
    "https://runtime.example.com/api/chat",
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReferenceId,
  categorizeError,
  friendlyRuntimeErrorMessage,
  OpenClawRuntimeError,
  runtimeErrorFromNetworkFailure,
  runtimeErrorFromResponse,
} from "../src/openclaw/errors.js";
import { describeJobFailure } from "../src/discord/jobRunner.js";

const GENERIC_FALLBACK =
  "The assistant could not respond right now. Please try again shortly.";

test("adapter category fields are preserved from structured error bodies", () => {
  const error = runtimeErrorFromResponse(
    503,
    JSON.stringify({
      error: "The assistant runtime is restarting or unreachable.",
      category: "runtime_unreachable",
      requestId: "abc12345",
    }),
  );

  assert.equal(error.category, "runtime_unreachable");
  assert.equal(error.requestId, "abc12345");
  assert.equal(error.status, 503);
});

test("status codes classify when the body is not structured", () => {
  assert.equal(runtimeErrorFromResponse(404, "Not Found").category, "runtime_unreachable");
  assert.equal(runtimeErrorFromResponse(503, "").category, "runtime_unreachable");
  assert.equal(runtimeErrorFromResponse(504, "").category, "provider_timeout");
  assert.equal(runtimeErrorFromResponse(500, "boom").category, "unknown");
});

test("network failures classify as unreachable or timeout", () => {
  assert.equal(
    runtimeErrorFromNetworkFailure(new TypeError("fetch failed")).category,
    "runtime_unreachable",
  );
  assert.equal(
    runtimeErrorFromNetworkFailure(new Error("The operation was aborted due to timeout"))
      .category,
    "runtime_timeout",
  );
});

test("every category produces a useful, non-generic message with a reference id", () => {
  const categories = [
    "runtime_unreachable",
    "runtime_timeout",
    "provider_timeout",
    "plugin_validation_failed",
    "plugin_quarantined",
    "openclaw_config_invalid",
    "tool_execution_failed",
    "job_failed",
    "unknown",
  ] as const;

  for (const category of categories) {
    const message = friendlyRuntimeErrorMessage(
      new OpenClawRuntimeError("internal detail", { category }),
      "ref12345",
    );
    assert.notEqual(message, GENERIC_FALLBACK);
    assert.match(message, /\(ref ref12345\)/);
    assert.doesNotMatch(message, /internal detail/);
  }
});

test("plugin load-failure messages name the plugin and stay non-blocking in tone", () => {
  const message = friendlyRuntimeErrorMessage(
    new OpenClawRuntimeError("plugin exploded", {
      category: "plugin_quarantined",
      pluginId: "erxes-next-plugin",
    }),
    "ref1",
  );
  assert.match(message, /The plugin erxes-next-plugin is installed, but it could not be loaded/);
  assert.match(message, /assistant keeps working/i);
  assert.match(message, /retry/i);
  // Reframed: never presented as a refusal, block, or ban.
  assert.doesNotMatch(message, /quarantin|refus|block|bann/i);
});

test("adapter safeMessage wins over category defaults", () => {
  const message = friendlyRuntimeErrorMessage(
    new OpenClawRuntimeError("x", {
      category: "job_failed",
      safeMessage: "The runtime restarted before this job completed. Please retry.",
    }),
    "ref2",
  );
  assert.match(message, /runtime restarted before this job completed/);
});

test("categorizeError infers categories for plain errors", () => {
  assert.equal(categorizeError(new Error("fetch failed")), "runtime_unreachable");
  assert.equal(
    categorizeError(new Error("The operation was aborted due to timeout")),
    "runtime_timeout",
  );
  assert.equal(categorizeError(new Error("anything else")), "unknown");
});

test("reference ids derive from the message id", () => {
  assert.equal(buildReferenceId("1514923130156486726"), "56486726");
});

test("job failures map to structured messages, never the generic fallback", () => {
  assert.equal(
    describeJobFailure({ safeMessage: "The plugin x failed validation and was disabled. Other assistant features are still available." }),
    "The plugin x failed validation and was disabled. Other assistant features are still available.",
  );
  assert.match(
    describeJobFailure({ error: "The adapter restarted while the job was running" }),
    /runtime restarted before this job completed/i,
  );
  assert.match(
    describeJobFailure({ category: "runtime_unreachable", error: "fetch failed" }),
    /runtime is currently unreachable/i,
  );
  assert.match(
    describeJobFailure({ category: "provider_timeout", error: "timeout" }),
    /provider timed out/i,
  );
  assert.match(
    describeJobFailure({ category: "plugin_quarantined", error: "bad plugin" }),
    /installed but could not be loaded.*kept unloaded/i,
  );
  assert.match(
    describeJobFailure({ error: "some specific reason" }),
    /The operation failed: some specific reason/,
  );
  assert.notEqual(describeJobFailure({}), GENERIC_FALLBACK);
});

test("error messages never contain secret-looking content from internals", () => {
  const message = friendlyRuntimeErrorMessage(
    new Error("Bearer abcdef1234567890abcdef sk-secretsecretsecret mongodb://u:p@h/db"),
    "ref3",
  );
  assert.doesNotMatch(message, /Bearer/);
  assert.doesNotMatch(message, /sk-/);
  assert.doesNotMatch(message, /mongodb/);
});

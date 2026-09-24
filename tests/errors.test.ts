import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReferenceId,
  categorizeError,
  friendlyRuntimeErrorMessage,
  OpenClawRuntimeError,
  REQUEST_TOO_LARGE_MESSAGE,
  RUNTIME_ERROR_CATEGORIES,
  runtimeErrorFromNetworkFailure,
  runtimeErrorFromResponse,
} from "../src/openclaw/errors.js";
import {
  describeJobFailure,
  GENERIC_JOB_FAILURE_MESSAGE,
} from "../src/discord/jobRunner.js";

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
  assert.equal(
    describeJobFailure({ error: "some specific reason" }),
    GENERIC_JOB_FAILURE_MESSAGE,
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

const ADAPTER_CATEGORIES = [
  "provider_busy",
  "provider_not_connected",
  "job_deadline",
  "provider_quota",
  "provider_billing",
  "provider_auth_failed",
  "provider_rate_limited",
  "provider_error",
] as const;

test("adapter provider categories are recognised, not collapsed to unknown", () => {
  for (const category of ADAPTER_CATEGORIES) {
    assert.ok((RUNTIME_ERROR_CATEGORIES as readonly string[]).includes(category));
    const error = runtimeErrorFromResponse(
      503,
      JSON.stringify({ error: "internal detail", category }),
    );
    assert.equal(error.category, category);
    const message = friendlyRuntimeErrorMessage(error, "ref9");
    assert.match(message, /\(ref ref9\)/);
    assert.doesNotMatch(message, /internal detail/);
    assert.doesNotMatch(message, /unexpected error/);
  }
});

test("adapter safeMessage wins over the provider category fallback", () => {
  const error = runtimeErrorFromResponse(
    429,
    JSON.stringify({
      error: "concurrent request limit",
      category: "provider_busy",
      safeMessage: "Your Kimi key is busy with another assistant.",
    }),
  );
  assert.equal(
    friendlyRuntimeErrorMessage(error, "ref4"),
    "Your Kimi key is busy with another assistant. (ref ref4)",
  );
});

test("a provider category on a 401/402 keeps its own message", () => {
  const error = runtimeErrorFromResponse(
    402,
    JSON.stringify({ error: "x", category: "provider_quota" }),
  );
  assert.match(friendlyRuntimeErrorMessage(error, "r"), /quota/i);
});

test("an oversized request says so instead of asking to rephrase", () => {
  const error = runtimeErrorFromResponse(
    400,
    JSON.stringify({ error: "Request body is too large", category: "invalid_request" }),
  );
  const message = friendlyRuntimeErrorMessage(error, "ref5");
  assert.equal(message, `${REQUEST_TOO_LARGE_MESSAGE} (ref ref5)`);
  assert.match(message, /smaller file|split/i);
  assert.doesNotMatch(message, /rephrase/i);

  assert.equal(runtimeErrorFromResponse(413, "").category, "invalid_request");
  assert.match(
    friendlyRuntimeErrorMessage(runtimeErrorFromResponse(413, ""), "r"),
    /too large/,
  );
  // Other invalid requests keep the rephrase guidance.
  assert.match(
    friendlyRuntimeErrorMessage(
      runtimeErrorFromResponse(400, JSON.stringify({ error: "bad", category: "invalid_request" })),
      "r",
    ),
    /rephrase/,
  );
});

test("job failures never leak the raw runtime error", () => {
  const raw = "ENOENT /root/.openclaw/agents/main Bearer abc sk-kimi-123";
  for (const status of [
    { error: raw },
    { error: raw, category: "unknown" },
    { error: raw, category: "not_a_category" },
    { error: raw, category: "job_failed" },
    { error: raw, category: "provider_busy" },
  ]) {
    const message = describeJobFailure(status);
    assert.doesNotMatch(message, /ENOENT|Bearer|sk-kimi|\/root/);
  }
  assert.match(describeJobFailure({ error: raw, category: "provider_busy" }), /busy/i);
  assert.equal(
    describeJobFailure({ error: "Request body is too large" }),
    REQUEST_TOO_LARGE_MESSAGE,
  );
});

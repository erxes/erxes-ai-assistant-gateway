import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withRuntimeRetry,
  shouldRetryRuntimeError,
  RUNTIME_RETRY_SCHEDULE_MS,
} from "../src/openclaw/client.js";
import { OpenClawRuntimeError } from "../src/openclaw/errors.js";

const instantSleep = () => Promise.resolve();

const runtimeError = (
  status: number | undefined,
  category:
    | "runtime_unreachable"
    | "tool_execution_failed"
    | "runtime_timeout"
    | "provider_timeout"
    | "unknown" = "unknown",
) => new OpenClawRuntimeError(`status ${status}`, { category, status });

test("429 (runtime busy) retries through the full schedule, then surfaces", async () => {
  let calls = 0;

  await assert.rejects(
    withRuntimeRetry(
      async () => {
        calls += 1;
        throw runtimeError(429, "tool_execution_failed");
      },
      { sleep: instantSleep },
    ),
    (error: unknown) =>
      error instanceof OpenClawRuntimeError && error.status === 429,
  );

  assert.equal(calls, RUNTIME_RETRY_SCHEDULE_MS.length + 1);
});

test("runtime_unreachable (pod restart) keeps retrying and succeeds when the pod returns", async () => {
  let calls = 0;

  const result = await withRuntimeRetry(
    async () => {
      calls += 1;
      if (calls < 4) throw runtimeError(503, "runtime_unreachable");
      return "answered";
    },
    { sleep: instantSleep },
  );

  assert.equal(result, "answered");
  assert.equal(calls, 4);
});

test("500 retries at most twice — bounded duplicate side-effect exposure", async () => {
  let calls = 0;

  await assert.rejects(
    withRuntimeRetry(
      async () => {
        calls += 1;
        throw runtimeError(500, "tool_execution_failed");
      },
      { sleep: instantSleep },
    ),
  );

  assert.equal(calls, 3); // initial + 2 retries
});

test("401 dead key fails immediately — retrying cannot fix billing", async () => {
  let calls = 0;

  await assert.rejects(
    withRuntimeRetry(
      async () => {
        calls += 1;
        throw runtimeError(401, "tool_execution_failed");
      },
      { sleep: instantSleep },
    ),
  );

  assert.equal(calls, 1);
});

test("timeouts are never retried — re-running long work compounds the problem", async () => {
  let calls = 0;

  await assert.rejects(
    withRuntimeRetry(
      async () => {
        calls += 1;
        throw runtimeError(undefined, "runtime_timeout");
      },
      { sleep: instantSleep },
    ),
  );

  assert.equal(calls, 1);
  assert.equal(
    shouldRetryRuntimeError(runtimeError(504, "provider_timeout"), 0),
    false,
  );
});

test("non-runtime errors (bugs) are never retried", async () => {
  let calls = 0;

  await assert.rejects(
    withRuntimeRetry(
      async () => {
        calls += 1;
        throw new TypeError("undefined is not a function");
      },
      { sleep: instantSleep },
    ),
  );

  assert.equal(calls, 1);
});

test("onRetry reports attempt numbers and waits; a throwing hook does not break the loop", async () => {
  const seen: number[] = [];
  let calls = 0;

  const result = await withRuntimeRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw runtimeError(429, "unknown");
      return "ok";
    },
    {
      sleep: instantSleep,
      onRetry: ({ attempt, delayMs }) => {
        seen.push(attempt);
        assert.equal(delayMs, RUNTIME_RETRY_SCHEDULE_MS[attempt - 1]);
        throw new Error("hook exploded");
      },
    },
  );

  assert.equal(result, "ok");
  assert.deepEqual(seen, [1, 2]);
});

test("schedule totals enough patience to cover a pod restart", () => {
  const total = RUNTIME_RETRY_SCHEDULE_MS.reduce((a, b) => a + b, 0);
  assert.ok(
    total >= 120_000,
    `schedule sums to ${total}ms — must cover a 60-120s deployer-initiated pod restart`,
  );
});

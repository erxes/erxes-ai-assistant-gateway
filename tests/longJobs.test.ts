import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildJobIdempotencyKey,
  runDiscordAssistantJob,
  type AssistantJobRecord,
  type AssistantJobStore,
} from "../src/discord/jobRunner.js";
import {
  detectLongRunningOperation,
  summarizeOperation,
} from "../src/discord/longOps.js";
import { handleDiscordMessage } from "../src/discord/messageGateway.js";

const record: AssistantJobRecord = {
  tenantId: "tenant-1",
  assistantId: "assistant-1",
  openclawUrl: "https://assistant.example.com",
  guildId: "guild-1",
  channelId: "channel-1",
  threadId: undefined,
  messageId: "message-1",
  conversationKey: "discord:guild-1:channel-1",
  opType: "install",
  operation: "install here-now",
  idempotencyKey: "assistant-1:install:message-1",
};

const askInput = {
  openclawUrl: "https://assistant.example.com",
  tenantId: "tenant-1",
  assistantId: "assistant-1",
  question: "install here-now",
  user: { id: "user-1", username: "User One" },
  discord: { guildId: "guild-1", channelId: "channel-1" },
};

const createMemoryStore = (initialKeys: string[] = []) => {
  const keys = new Set(initialKeys);
  const updates: Array<{ key: string; patch: Record<string, unknown> }> = [];

  const store: AssistantJobStore = {
    async create(input) {
      if (keys.has(input.idempotencyKey)) {
        return { created: false };
      }
      keys.add(input.idempotencyKey);
      return { created: true, id: input.idempotencyKey };
    },
    async update(key, patch) {
      updates.push({ key, patch });
    },
  };

  return { store, updates, keys };
};

const silentLogger = { info: () => undefined, error: () => undefined } as any;

test("long operation detection matches install/plugin/agent/cron phrasing", () => {
  assert.equal(detectLongRunningOperation("install here-now"), "install");
  assert.equal(detectLongRunningOperation("please INSTALL plugin maton"), "install");
  assert.equal(detectLongRunningOperation("npm install left-pad"), "install");
  assert.equal(detectLongRunningOperation("enable the browser plugin"), "enable-plugin");
  assert.equal(detectLongRunningOperation("create a sub-agent for sales"), "create-agent");
  assert.equal(
    detectLongRunningOperation("run a browser workflow to check the site"),
    "browser-workflow",
  );
  assert.equal(detectLongRunningOperation("set up a cron job for reports"), "cron-setup");
  assert.equal(
    detectLongRunningOperation("process this large file for me"),
    "file-processing",
  );

  assert.equal(detectLongRunningOperation("hello there"), null);
  assert.equal(detectLongRunningOperation("what plugins are installed?"), null);
  assert.equal(detectLongRunningOperation("which channel is this?"), null);
});

test("summarizeOperation strips control characters and caps length", () => {
  assert.equal(summarizeOperation("install\u0000 here-now\n\nplease"), "install here-now please");
  assert.equal(summarizeOperation("a".repeat(300)).length, 140);
});

test("job idempotency key combines assistant, op type, and message id", () => {
  assert.equal(
    buildJobIdempotencyKey({
      assistantId: "a1",
      opType: "install",
      messageId: "m1",
    }),
    "a1:install:m1",
  );
});

test("job happy path acks, polls, and posts the final answer", async () => {
  const { store, updates } = createMemoryStore();
  const acks: string[] = [];
  const notifications: string[] = [];
  let polls = 0;

  const outcome = await runDiscordAssistantJob({
    record,
    ask: askInput,
    store,
    ack: async (content) => acks.push(content),
    notify: async (content) => notifications.push(content),
    startJob: async (input) => {
      assert.equal((input as { jobKey?: string }).jobKey, record.idempotencyKey);
      return { id: "job-1", status: "running" as const };
    },
    getJob: async () => {
      polls += 1;
      return polls < 2
        ? { id: "job-1", status: "running" as const, stage: "running" }
        : { id: "job-1", status: "ready" as const, stage: "ready", answer: "installed!" };
    },
    logger: silentLogger,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
  });

  assert.equal(outcome, "ready");
  assert.deepEqual(acks, ["Started. I'll post progress here."]);
  assert.deepEqual(notifications, ["installed!"]);
  assert.ok(updates.some((u) => u.patch.status === "ready"));
});

test("duplicate idempotency key creates no job and sends no messages", async () => {
  const { store } = createMemoryStore([record.idempotencyKey]);
  const acks: string[] = [];
  const notifications: string[] = [];

  const outcome = await runDiscordAssistantJob({
    record,
    ask: askInput,
    store,
    ack: async (content) => acks.push(content),
    notify: async (content) => notifications.push(content),
    startJob: async () => {
      throw new Error("should not start a duplicate job");
    },
    getJob: async () => {
      throw new Error("should not poll a duplicate job");
    },
    logger: silentLogger,
    pollIntervalMs: 1,
    timeoutMs: 1_000,
  });

  assert.equal(outcome, "duplicate");
  assert.deepEqual(acks, []);
  assert.deepEqual(notifications, []);
});

test("failed job posts a failure message", async () => {
  const { store, updates } = createMemoryStore();
  const notifications: string[] = [];

  const outcome = await runDiscordAssistantJob({
    record,
    ask: askInput,
    store,
    ack: async () => undefined,
    notify: async (content) => notifications.push(content),
    startJob: async () => ({ id: "job-1", status: "running" as const }),
    getJob: async () => ({
      id: "job-1",
      status: "failed" as const,
      stage: "failed",
      error: "Install exploded",
    }),
    logger: silentLogger,
    pollIntervalMs: 1,
    timeoutMs: 1_000,
  });

  assert.equal(outcome, "failed");
  assert.deepEqual(notifications, ["The operation failed: Install exploded"]);
  assert.ok(
    updates.some(
      (u) => u.patch.status === "failed" && u.patch.error === "Install exploded",
    ),
  );
});

test("job timeout marks the job failed and posts a timeout message", async () => {
  const { store, updates } = createMemoryStore();
  const notifications: string[] = [];

  const outcome = await runDiscordAssistantJob({
    record,
    ask: askInput,
    store,
    ack: async () => undefined,
    notify: async (content) => notifications.push(content),
    startJob: async () => ({ id: "job-1", status: "running" as const }),
    getJob: async () => ({ id: "job-1", status: "running" as const, stage: "running" }),
    logger: silentLogger,
    pollIntervalMs: 1,
    timeoutMs: 25,
  });

  assert.equal(outcome, "timeout");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]!, /timed out/);
  assert.ok(updates.some((u) => u.patch.error === "Job timed out"));
});

test("job logs never include the question text or secrets", async () => {
  const { store } = createMemoryStore();
  const logged: Array<Record<string, unknown>> = [];
  const logger = {
    info: (_msg: string, meta?: Record<string, unknown>) => {
      if (meta) logged.push(meta);
    },
    error: (_msg: string, meta?: Record<string, unknown>) => {
      if (meta) logged.push(meta);
    },
  } as any;

  await runDiscordAssistantJob({
    record: { ...record, operation: "install secret-thing" },
    ask: { ...askInput, question: "install secret-thing TOKEN=abc123" },
    store,
    ack: async () => undefined,
    notify: async () => undefined,
    startJob: async () => ({ id: "job-1", status: "running" as const }),
    getJob: async () => ({ id: "job-1", status: "ready" as const, answer: "done" }),
    logger,
    pollIntervalMs: 1,
    timeoutMs: 1_000,
  });

  const flat = JSON.stringify(logged);
  assert.doesNotMatch(flat, /TOKEN=abc123/);
  assert.doesNotMatch(flat, /secret-thing/);
  assert.match(flat, /assistant-1/);
});

const createJobMessageFixture = (overrides: Record<string, unknown> = {}) => {
  const replies: unknown[] = [];
  const sends: unknown[] = [];

  const message = {
    id: "message-1",
    guildId: "guild-1",
    channelId: "channel-1",
    content: "install here-now",
    webhookId: null,
    system: false,
    type: 0,
    author: { id: "user-1", username: "User One", bot: false },
    attachments: { size: 0, map: () => [] },
    channel: {
      sendTyping: async () => undefined,
      send: async (payload: unknown) => {
        sends.push(payload);
      },
    },
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
    ...overrides,
  } as any;

  return { message, replies, sends };
};

const binding = {
  tenantId: "tenant-1",
  assistantId: "assistant-1",
  discordGuildId: "guild-1",
  discordChannelId: "channel-1",
  openclawUrl: "https://assistant.example.com",
  enabled: true,
  responseMode: "all_messages",
} as any;

test("long operations route to the job runner instead of the sync ask", async () => {
  const fixture = createJobMessageFixture();
  let asked = false;
  let jobRequest: any = null;

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined } as any,
    findBinding: async () => binding,
    askAssistant: async () => {
      asked = true;
      return "should not be used";
    },
    runLongOperationJob: async (request) => {
      jobRequest = request;
    },
  });

  assert.equal(asked, false);
  assert.ok(jobRequest);
  assert.equal(jobRequest.opType, "install");
  assert.equal(jobRequest.messageId, "message-1");
  assert.equal(jobRequest.conversationId, "discord:guild-1:channel-1");
});

test("long operation job replies go back to the thread when started in a thread", async () => {
  const fixture = createJobMessageFixture({
    channelId: "thread-1",
    channel: {
      isThread: () => true,
      parentId: "channel-1",
      name: "install-thread",
      sendTyping: async () => undefined,
      send: async (payload: unknown) => {
        fixture.sends.push(payload);
      },
    },
  });
  let jobRequest: any = null;

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined } as any,
    findBinding: async (input) =>
      input.channelId === "channel-1" ? binding : null,
    askAssistant: async () => "unused",
    runLongOperationJob: async (request) => {
      jobRequest = request;
      await request.ack("Started. I'll post progress here.");
      await request.notify("done!");
    },
  });

  assert.ok(jobRequest);
  assert.equal(jobRequest.threadId, "thread-1");
  assert.equal(jobRequest.channelId, "channel-1");
  assert.equal(
    jobRequest.conversationId,
    "discord:guild-1:channel-1:thread-1",
  );
  assert.equal(fixture.replies.length, 1);
  assert.deepEqual(fixture.sends, [
    { content: "done!", allowedMentions: { repliedUser: false } },
  ]);
});

test("normal chat is async-first: routed as a delayed-ack quiet job, no sync ask", async () => {
  const fixture = createJobMessageFixture({ content: "what is our pipeline?" });
  let asked = false;
  let jobRequest: any = null;

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined } as any,
    findBinding: async () => binding,
    askAssistant: async () => {
      asked = true;
      return "pipeline answer";
    },
    runLongOperationJob: async (request) => {
      jobRequest = request;
    },
  });

  // Exactly one model path: the async job. No sync /ask call.
  assert.equal(asked, false);
  assert.ok(jobRequest);
  assert.equal(jobRequest.opType, "chat");
  assert.equal(jobRequest.ackMode, "delayed");
  assert.equal(jobRequest.quiet, true);
  assert.equal(jobRequest.ask.question, "what is our pipeline?");
  // No immediate reply for normal chat — the runner decides if/when to ack.
  assert.equal(fixture.replies.length, 0);
});

test("normal chat first outbound replies to the message, later ones go to the channel", async () => {
  const fixture = createJobMessageFixture({ content: "hello there" });
  let jobRequest: any = null;

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined } as any,
    findBinding: async () => binding,
    askAssistant: async () => "unused",
    runLongOperationJob: async (request) => {
      jobRequest = request;
    },
  });

  await jobRequest.ack("Still working — I'll post the answer here when it's ready.");
  await jobRequest.notify("final answer");
  await jobRequest.notify("second chunk");

  assert.equal(fixture.replies.length, 1);
  assert.match((fixture.replies[0] as any).content, /Still working/);
  assert.equal(fixture.sends.length, 2);
  assert.equal((fixture.sends[0] as any).content, "final answer");
});

test("image-only chat goes through the async-first path with attachments intact", async () => {
  const attachment = {
    name: "photo.png",
    contentType: "image/png",
    size: 1024,
    url: "https://cdn.discordapp.com/attachments/1/2/photo.png?ex=a&is=b&hm=c",
  };
  const fixture = createJobMessageFixture({
    content: "Describe this image.",
    attachments: { size: 1, map: (fn: (item: unknown) => unknown) => [fn(attachment)] },
  });
  let jobRequest: any = null;

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined, info: () => undefined } as any,
    findBinding: async () => binding,
    askAssistant: async () => "unused",
    runLongOperationJob: async (request) => {
      jobRequest = request;
    },
  });

  assert.ok(jobRequest);
  assert.equal(jobRequest.opType, "chat");
  assert.equal(jobRequest.ackMode, "delayed");
  assert.equal(jobRequest.ask.discord.attachments.length, 1);
  assert.equal(jobRequest.ask.discord.attachments[0].kind, "image");
});

test("thread chat keeps thread routing through the async-first path", async () => {
  const fixture = createJobMessageFixture({
    content: "thread question",
    channelId: "thread-9",
    channel: {
      sendTyping: async () => undefined,
      send: async () => undefined,
      isThread: () => true,
      parentId: "channel-1",
      name: "thread name",
      parent: { name: "general" },
    },
  });
  let jobRequest: any = null;

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined } as any,
    findBinding: async () => binding,
    askAssistant: async () => "unused",
    runLongOperationJob: async (request) => {
      jobRequest = request;
    },
  });

  assert.ok(jobRequest);
  assert.equal(jobRequest.channelId, "channel-1");
  assert.equal(jobRequest.threadId, "thread-9");
  assert.equal(jobRequest.conversationId, "discord:guild-1:channel-1:thread-9");
});

test("delayed ack mode: quick job answers normally with no 'Still working' ack", async () => {
  const { store } = createMemoryStore();
  const acks: string[] = [];
  const notifications: string[] = [];

  const outcome = await runDiscordAssistantJob({
    record,
    ask: askInput,
    store,
    ack: async (content) => acks.push(content),
    notify: async (content) => notifications.push(content),
    startJob: async () => ({ id: "job-1", status: "running" as const }),
    getJob: async () => ({
      id: "job-1",
      status: "ready" as const,
      stage: "ready",
      answer: "quick answer",
    }),
    logger: silentLogger,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
    ackMode: "delayed",
    ackDelayMs: 60_000,
    quiet: true,
  });

  assert.equal(outcome, "ready");
  assert.deepEqual(acks, []);
  assert.deepEqual(notifications, ["quick answer"]);
});

test("delayed ack mode: slow job sends 'Still working' then the final answer", async () => {
  const { store } = createMemoryStore();
  const acks: string[] = [];
  const notifications: string[] = [];
  let polls = 0;

  const outcome = await runDiscordAssistantJob({
    record,
    ask: askInput,
    store,
    ack: async (content) => acks.push(content),
    notify: async (content) => notifications.push(content),
    startJob: async () => ({ id: "job-1", status: "running" as const }),
    getJob: async () => {
      polls += 1;
      return polls < 3
        ? { id: "job-1", status: "running" as const, stage: "running" }
        : { id: "job-1", status: "ready" as const, stage: "ready", answer: "slow answer" };
    },
    logger: silentLogger,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
    ackMode: "delayed",
    ackDelayMs: 0,
    quiet: true,
  });

  assert.equal(outcome, "ready");
  assert.deepEqual(acks, [
    "Still working — I'll post the answer here when it's ready.",
  ]);
  assert.deepEqual(notifications, ["slow answer"]);
});

test("delayed ack mode: failed job posts a structured reason, never the generic fallback", async () => {
  const { store } = createMemoryStore();
  const acks: string[] = [];
  const notifications: string[] = [];

  const outcome = await runDiscordAssistantJob({
    record,
    ask: askInput,
    store,
    ack: async (content) => acks.push(content),
    notify: async (content) => notifications.push(content),
    startJob: async () => ({ id: "job-1", status: "running" as const }),
    getJob: async () => ({
      id: "job-1",
      status: "failed" as const,
      stage: "failed",
      error: "fetch failed",
      category: "runtime_unreachable",
    }),
    logger: silentLogger,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
    ackMode: "delayed",
    ackDelayMs: 0,
    quiet: true,
  });

  assert.equal(outcome, "failed");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /runtime is currently unreachable/i);
  assert.notEqual(
    notifications[0],
    "The assistant could not respond right now. Please try again shortly.",
  );
});

test("quiet mode suppresses intermediate stage messages", async () => {
  const { store } = createMemoryStore();
  const notifications: string[] = [];
  let polls = 0;

  await runDiscordAssistantJob({
    record,
    ask: askInput,
    store,
    ack: async () => undefined,
    notify: async (content) => notifications.push(content),
    startJob: async () => ({ id: "job-1", status: "running" as const }),
    getJob: async () => {
      polls += 1;
      return polls < 2
        ? { id: "job-1", status: "verifying" as const, stage: "verifying" }
        : { id: "job-1", status: "ready" as const, stage: "ready", answer: "done" };
    },
    logger: silentLogger,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
    ackMode: "delayed",
    ackDelayMs: 60_000,
    quiet: true,
  });

  assert.deepEqual(notifications, ["done"]);
});

test("long operations keep the immediate 'Started' ack through the new options", async () => {
  const { store } = createMemoryStore();
  const acks: string[] = [];

  await runDiscordAssistantJob({
    record,
    ask: askInput,
    store,
    ack: async (content) => acks.push(content),
    notify: async () => undefined,
    startJob: async () => ({ id: "job-1", status: "running" as const }),
    getJob: async () => ({ id: "job-1", status: "ready" as const, answer: "ok" }),
    logger: silentLogger,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
    ackMode: "immediate",
  });

  assert.deepEqual(acks, ["Started. I'll post progress here."]);
});

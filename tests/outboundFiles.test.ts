import assert from "node:assert/strict";
import { test } from "node:test";

import { runDiscordAssistantJob } from "../src/discord/jobRunner.js";
import {
  buildRuntimeFilePayloads,
  handleDiscordMessage,
} from "../src/discord/messageGateway.js";
import { parseRuntimeGeneratedFiles } from "../src/openclaw/client.js";

const FILE_ID = "12345678-1234-1234-1234-123456789abc";

const runtimeFile = (overrides: Record<string, unknown> = {}) => ({
  fileId: FILE_ID,
  filename: "report.csv",
  contentType: "text/csv",
  size: 25,
  ...overrides,
});

const binding = {
  tenantId: "tenant-1",
  assistantId: "assistant-1",
  discordGuildId: "guild-1",
  discordChannelId: "channel-1",
  openclawUrl: "https://assistant.example.com",
  enabled: true,
  responseMode: "all_messages",
} as any;

const createFixture = (overrides: Record<string, unknown> = {}) => {
  const replies: unknown[] = [];
  const sends: any[] = [];

  const message = {
    id: "message-1",
    guildId: "guild-1",
    channelId: "channel-1",
    content: "make me a csv",
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

const silentLogger = { error: () => undefined, info: () => undefined } as any;

test("parseRuntimeGeneratedFiles filters malformed entries", () => {
  assert.deepEqual(parseRuntimeGeneratedFiles(undefined), []);
  assert.deepEqual(parseRuntimeGeneratedFiles([{ fileId: "../etc" }]), []);
  assert.equal(parseRuntimeGeneratedFiles([runtimeFile()]).length, 1);
});

test("sync response with generated file uploads to the channel", async () => {
  const fixture = createFixture();

  await handleDiscordMessage(fixture.message, {
    logger: silentLogger,
    findBinding: async () => binding,
    askAssistant: async () =>
      ({ answer: "Created your CSV.", files: [runtimeFile()], fileErrors: [] }) as any,
    fetchRuntimeFile: async (url, fileId) => {
      assert.equal(url, "https://assistant.example.com");
      assert.equal(fileId, FILE_ID);
      return Buffer.from("name,role\n");
    },
  });

  assert.equal(fixture.replies.length, 1);
  assert.equal((fixture.replies[0] as any).content, "Created your CSV.");
  const upload = fixture.sends.find((s) => s.files);
  assert.ok(upload);
  assert.equal(upload.content, "Here is the generated file.");
  assert.equal(upload.files[0].name, "report.csv");
  assert.ok(Buffer.isBuffer(upload.files[0].attachment));
});

test("file fetch failure sends a friendly upload error", async () => {
  const fixture = createFixture();

  await handleDiscordMessage(fixture.message, {
    logger: silentLogger,
    findBinding: async () => binding,
    askAssistant: async () =>
      ({ answer: "Created.", files: [runtimeFile()], fileErrors: [] }) as any,
    fetchRuntimeFile: async () => {
      throw new Error("404");
    },
  });

  const friendly = fixture.sends.find(
    (s) => s.content === "I created the file, but couldn't upload it to Discord.",
  );
  assert.ok(friendly);
});

test("adapter fileErrors are surfaced as a note", async () => {
  const fixture = createFixture();

  await handleDiscordMessage(fixture.message, {
    logger: silentLogger,
    findBinding: async () => binding,
    askAssistant: async () =>
      ({
        answer: "Done.",
        files: [],
        fileErrors: ["openclaw.json: file is outside the outputs directory"],
      }) as any,
  });

  const note = fixture.sends.find((s) =>
    String(s.content).includes("couldn't be prepared"),
  );
  assert.ok(note);
  assert.match(note.content, /outside the outputs directory/);
});

test("multiple files are uploaded together and capped", async () => {
  const files = Array.from({ length: 7 }, (_, i) =>
    runtimeFile({
      fileId: FILE_ID.slice(0, 35) + String(i),
      filename: `f${i}.txt`,
      contentType: "text/plain",
    }),
  );
  const { payloads } = await buildRuntimeFilePayloads(
    "https://assistant.example.com",
    files as any,
    async () => Buffer.from("x"),
  );

  assert.equal(payloads.length, 5);
});

test("async job ready result delivers files via deliverFiles", async () => {
  const notifications: string[] = [];
  const delivered: unknown[] = [];

  const outcome = await runDiscordAssistantJob({
    record: {
      tenantId: "t",
      assistantId: "a",
      openclawUrl: "https://assistant.example.com",
      guildId: "g",
      channelId: "c",
      messageId: "m",
      conversationKey: "discord:g:c",
      opType: "file-processing",
      operation: "make csv",
      idempotencyKey: "a:file-processing:m",
    },
    ask: {
      openclawUrl: "https://assistant.example.com",
      tenantId: "t",
      assistantId: "a",
      question: "make csv",
      user: { id: "u", username: "U" },
      discord: { guildId: "g", channelId: "c" },
    },
    store: {
      create: async () => ({ created: true, id: "1" }),
      update: async () => undefined,
    },
    ack: async () => undefined,
    notify: async (content) => {
      notifications.push(content);
    },
    deliverFiles: async (files) => {
      delivered.push(...files);
    },
    startJob: async () => ({ id: "job-1", status: "running" as const }),
    getJob: async () => ({
      id: "job-1",
      status: "ready" as const,
      answer: "csv done",
      files: [runtimeFile() as any],
    }),
    logger: silentLogger,
    pollIntervalMs: 1,
    timeoutMs: 1_000,
  });

  assert.equal(outcome, "ready");
  assert.deepEqual(notifications, ["csv done"]);
  assert.equal(delivered.length, 1);
});

test("async job file delivery failure posts a friendly message", async () => {
  const notifications: string[] = [];

  await runDiscordAssistantJob({
    record: {
      tenantId: "t",
      assistantId: "a",
      openclawUrl: "https://assistant.example.com",
      guildId: "g",
      channelId: "c",
      messageId: "m2",
      conversationKey: "discord:g:c",
      opType: "file-processing",
      operation: "make csv",
      idempotencyKey: "a:file-processing:m2",
    },
    ask: {
      openclawUrl: "https://assistant.example.com",
      tenantId: "t",
      assistantId: "a",
      question: "make csv",
      user: { id: "u", username: "U" },
      discord: { guildId: "g", channelId: "c" },
    },
    store: {
      create: async () => ({ created: true, id: "1" }),
      update: async () => undefined,
    },
    ack: async () => undefined,
    notify: async (content) => {
      notifications.push(content);
    },
    deliverFiles: async () => {
      throw new Error("download failed");
    },
    startJob: async () => ({ id: "job-1", status: "running" as const }),
    getJob: async () => ({
      id: "job-1",
      status: "ready" as const,
      answer: "csv done",
      files: [runtimeFile() as any],
    }),
    logger: silentLogger,
    pollIntervalMs: 1,
    timeoutMs: 1_000,
  });

  assert.ok(
    notifications.includes(
      "I created the file, but couldn't upload it to Discord.",
    ),
  );
});

test("thread generated file uploads go to the thread channel", async () => {
  const fixture = createFixture({
    channelId: "thread-1",
    channel: {
      isThread: () => true,
      parentId: "channel-1",
      name: "csv-thread",
      sendTyping: async () => undefined,
      send: async (payload: unknown) => {
        fixture.sends.push(payload);
      },
    },
  });

  await handleDiscordMessage(fixture.message, {
    logger: silentLogger,
    findBinding: async (input) =>
      input.channelId === "channel-1" ? binding : null,
    askAssistant: async () =>
      ({ answer: "thread csv", files: [runtimeFile()], fileErrors: [] }) as any,
    fetchRuntimeFile: async () => Buffer.from("data"),
  });

  const upload = fixture.sends.find((s) => s.files);
  assert.ok(upload);
});

test("text-only responses remain unchanged with object results", async () => {
  const fixture = createFixture({ content: "hello there" });

  await handleDiscordMessage(fixture.message, {
    logger: silentLogger,
    findBinding: async () => binding,
    askAssistant: async () =>
      ({ answer: "hi!", files: [], fileErrors: [] }) as any,
  });

  assert.equal(fixture.replies.length, 1);
  assert.equal(fixture.sends.length, 0);
});

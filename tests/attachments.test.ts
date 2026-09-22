import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attachmentRejectionMessage,
  isAllowedDiscordAttachmentUrl,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  normalizeDiscordAttachments,
  redactAttachmentUrl,
  sanitizeAttachmentFilename,
  skippedAttachmentsNote,
} from "../src/discord/attachments.js";
import { handleDiscordMessage } from "../src/discord/messageGateway.js";

const cdn = (name: string) =>
  `https://cdn.discordapp.com/attachments/1/2/${name}?ex=abc&is=def&hm=signature`;

const imageAttachment = (overrides: Record<string, unknown> = {}) => ({
  filename: "photo.png",
  contentType: "image/png",
  size: 1024,
  url: cdn("photo.png"),
  ...overrides,
});

test("supported image and file attachments normalize with kind", () => {
  const { supported, skipped } = normalizeDiscordAttachments([
    imageAttachment(),
    {
      filename: "report.pdf",
      contentType: "application/pdf",
      size: 2048,
      url: cdn("report.pdf"),
    },
    {
      filename: "notes.md",
      contentType: "text/markdown; charset=utf-8",
      size: 100,
      url: cdn("notes.md"),
    },
  ]);

  assert.equal(skipped.length, 0);
  assert.deepEqual(
    supported.map((a) => [a.kind, a.contentType]),
    [
      ["image", "image/png"],
      ["file", "application/pdf"],
      ["file", "text/markdown"],
    ],
  );
});

test("unsupported MIME is skipped with friendly message", () => {
  const { supported, skipped } = normalizeDiscordAttachments([
    imageAttachment({ filename: "evil.exe", contentType: "application/x-msdownload" }),
  ]);

  assert.equal(supported.length, 0);
  assert.deepEqual(skipped, [{ filename: "evil.exe", reason: "unsupported-type" }]);
  assert.equal(
    attachmentRejectionMessage(skipped),
    "This file type is not supported yet.",
  );
});

test("oversized attachments are skipped with friendly message", () => {
  const { skipped } = normalizeDiscordAttachments([
    imageAttachment({ size: MAX_IMAGE_BYTES + 1 }),
    {
      filename: "big.pdf",
      contentType: "application/pdf",
      size: MAX_FILE_BYTES + 1,
      url: cdn("big.pdf"),
    },
  ]);

  assert.deepEqual(
    skipped.map((s) => s.reason),
    ["too-large", "too-large"],
  );
  assert.equal(
    attachmentRejectionMessage(skipped),
    "This file is too large to process here.",
  );
});

test("non-Discord and non-HTTPS URLs are rejected", () => {
  assert.equal(isAllowedDiscordAttachmentUrl(cdn("ok.png")), true);
  assert.equal(
    isAllowedDiscordAttachmentUrl("https://media.discordapp.net/a/b/c.png"),
    true,
  );
  assert.equal(
    isAllowedDiscordAttachmentUrl("https://evil.example.com/c.png"),
    false,
  );
  assert.equal(
    isAllowedDiscordAttachmentUrl("http://cdn.discordapp.com/c.png"),
    false,
  );
  assert.equal(
    isAllowedDiscordAttachmentUrl("https://user:pass@cdn.discordapp.com/c.png"),
    false,
  );
  assert.equal(isAllowedDiscordAttachmentUrl("not a url"), false);

  const { skipped } = normalizeDiscordAttachments([
    imageAttachment({ url: "https://evil.example.com/photo.png" }),
  ]);
  assert.deepEqual(skipped, [{ filename: "photo.png", reason: "invalid-url" }]);
});

test("attachment URLs are redacted to origin + path in logs", () => {
  assert.equal(
    redactAttachmentUrl(cdn("secret.png")),
    "https://cdn.discordapp.com/attachments/1/2/secret.png",
  );
  assert.equal(redactAttachmentUrl("garbage"), "<invalid-url>");
});

test("filenames are sanitized against traversal and control chars", () => {
  assert.equal(sanitizeAttachmentFilename("../../etc/passwd"), "etc_passwd");
  assert.equal(sanitizeAttachmentFilename("a\u0007b\u0007c.png"), "abc.png");
  assert.equal(sanitizeAttachmentFilename(undefined), "attachment");
  assert.equal(sanitizeAttachmentFilename("x".repeat(300)).length, 100);
});

test("skipped note lists filenames and reasons", () => {
  const note = skippedAttachmentsNote([
    { filename: "evil.exe", reason: "unsupported-type" },
  ]);
  assert.match(note, /evil\.exe \(unsupported type\)/);
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
  const sends: unknown[] = [];

  const message = {
    id: "message-1",
    guildId: "guild-1",
    channelId: "channel-1",
    content: "hello",
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

const attachmentsCollection = (items: unknown[]) => ({
  size: items.length,
  map: (fn: (item: any) => unknown) => items.map(fn as any),
});

const discordAttachment = (overrides: Record<string, unknown> = {}) => ({
  name: "photo.png",
  contentType: "image/png",
  size: 1024,
  url: cdn("photo.png"),
  ...overrides,
});

test("text + image is forwarded with normalized attachment", async () => {
  const fixture = createFixture({
    content: "what is in this image?",
    attachments: attachmentsCollection([discordAttachment()]),
  });
  let forwarded: any = null;

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined, info: () => undefined } as any,
    findBinding: async () => binding,
    askAssistant: async (input) => {
      forwarded = input;
      return "a red square";
    },
  });

  assert.equal(forwarded.question, "what is in this image?");
  assert.equal(forwarded.discord.attachments.length, 1);
  assert.deepEqual(forwarded.discord.attachments[0], {
    kind: "image",
    filename: "photo.png",
    contentType: "image/png",
    size: 1024,
    url: cdn("photo.png"),
  });
  assert.equal(fixture.replies.length, 1);
});

test("image-only message is not ignored and is forwarded", async () => {
  const fixture = createFixture({
    content: "",
    attachments: attachmentsCollection([discordAttachment()]),
  });
  let forwarded: any = null;

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined, info: () => undefined } as any,
    findBinding: async () => binding,
    askAssistant: async (input) => {
      forwarded = input;
      return "described";
    },
  });

  assert.ok(forwarded);
  assert.equal(forwarded.question, "");
  assert.equal(forwarded.discord.attachments.length, 1);
  assert.equal(fixture.replies.length, 1);
});

test("multiple images are all forwarded", async () => {
  const fixture = createFixture({
    content: "compare these",
    attachments: attachmentsCollection([
      discordAttachment({ name: "a.png" }),
      discordAttachment({ name: "b.jpg", contentType: "image/jpeg", url: cdn("b.jpg") }),
    ]),
  });
  let forwarded: any = null;

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined, info: () => undefined } as any,
    findBinding: async () => binding,
    askAssistant: async (input) => {
      forwarded = input;
      return "compared";
    },
  });

  assert.equal(forwarded.discord.attachments.length, 2);
  assert.deepEqual(
    forwarded.discord.attachments.map((a: any) => a.filename),
    ["a.png", "b.jpg"],
  );
});

test("PDF attachments route through the async job path", async () => {
  const fixture = createFixture({
    content: "summarize this",
    attachments: attachmentsCollection([
      discordAttachment({
        name: "report.pdf",
        contentType: "application/pdf",
        url: cdn("report.pdf"),
      }),
    ]),
  });
  let asked = false;
  let jobRequest: any = null;

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined, info: () => undefined } as any,
    findBinding: async () => binding,
    askAssistant: async () => {
      asked = true;
      return "unused";
    },
    runLongOperationJob: async (request) => {
      jobRequest = request;
    },
  });

  assert.equal(asked, false);
  assert.ok(jobRequest);
  assert.equal(jobRequest.opType, "file-processing");
  assert.equal(jobRequest.ask.discord.attachments.length, 1);
  assert.equal(jobRequest.ask.discord.attachments[0].kind, "file");
});

test("attachment-only unsupported file gets a friendly error without asking", async () => {
  const fixture = createFixture({
    content: "",
    attachments: attachmentsCollection([
      discordAttachment({ name: "evil.exe", contentType: "application/x-msdownload" }),
    ]),
  });
  let asked = false;

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined, info: () => undefined } as any,
    findBinding: async () => binding,
    askAssistant: async () => {
      asked = true;
      return "unused";
    },
  });

  assert.equal(asked, false);
  assert.deepEqual(fixture.sends, [
    {
      content: "This file type is not supported yet.",
      allowedMentions: { repliedUser: false },
    },
  ]);
});

test("text with partially skipped attachments posts a skipped note", async () => {
  const fixture = createFixture({
    content: "look at this",
    attachments: attachmentsCollection([
      discordAttachment(),
      discordAttachment({ name: "evil.exe", contentType: "application/octet-stream" }),
    ]),
  });

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined, info: () => undefined } as any,
    findBinding: async () => binding,
    askAssistant: async () => "looked",
  });

  assert.equal(fixture.replies.length, 1);
  assert.equal(fixture.sends.length, 1);
  assert.match((fixture.sends[0] as any).content, /skipped 1 attachment/);
  assert.match((fixture.sends[0] as any).content, /evil\.exe/);
});

test("thread attachment replies stay in the thread channel", async () => {
  const fixture = createFixture({
    content: "",
    channelId: "thread-1",
    channel: {
      isThread: () => true,
      parentId: "channel-1",
      name: "img-thread",
      sendTyping: async () => undefined,
      send: async (payload: unknown) => {
        fixture.sends.push(payload);
      },
    },
    attachments: attachmentsCollection([discordAttachment()]),
  });
  let forwarded: any = null;

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined, info: () => undefined } as any,
    findBinding: async (input) =>
      input.channelId === "channel-1" ? binding : null,
    askAssistant: async (input) => {
      forwarded = input;
      return "thread image reply";
    },
  });

  assert.equal(
    forwarded.discord.conversationId,
    "discord:guild-1:channel-1:thread-1",
  );
  assert.equal(forwarded.discord.attachments.length, 1);
  assert.equal(fixture.replies.length, 1);
});

test("plain text chat without attachments is unchanged", async () => {
  const fixture = createFixture();
  let forwarded: any = null;

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined, info: () => undefined } as any,
    findBinding: async () => binding,
    askAssistant: async (input) => {
      forwarded = input;
      return "hi";
    },
  });

  assert.deepEqual(forwarded.discord.attachments, []);
  assert.equal(fixture.replies.length, 1);
  assert.equal(fixture.sends.length, 0);
});

test("normalizeDiscordAttachments infers the type from the extension when Discord sends none", () => {
  const { supported, skipped } = normalizeDiscordAttachments([
    { filename: "IMG_4021.jpg", contentType: "", size: 120_000, url: "https://cdn.discordapp.com/attachments/1/2/IMG_4021.jpg" },
    { filename: "deck.pptx", contentType: null, size: 300_000, url: "https://cdn.discordapp.com/attachments/1/2/deck.pptx" },
    { filename: "photo.heic", contentType: "", size: 120_000, url: "https://cdn.discordapp.com/attachments/1/2/photo.heic" },
  ]);
  assert.deepEqual(supported.map((a) => a.contentType), ["image/jpeg", "application/vnd.openxmlformats-officedocument.presentationml.presentation"]);
  assert.deepEqual(skipped.map((a) => a.filename), ["photo.heic"]);
});


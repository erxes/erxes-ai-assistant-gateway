import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageType } from "discord.js";

import {
  buildDiscordConversationId,
  createTtlMessageCache,
  handleDiscordMessage,
  shouldIgnoreDiscordMessage,
  splitDiscordMessage,
} from "../src/discord/messageGateway.js";

const createBinding = (overrides: Record<string, unknown> = {}) =>
  ({
    tenantId: "tenant-1",
    assistantId: "assistant-1",
    discordGuildId: "guild-1",
    discordChannelId: "channel-1",
    openclawUrl: "https://assistant.example.com",
    enabled: true,
    responseMode: "all_messages",
    ...overrides,
  }) as any;

const createMessage = (overrides: Record<string, unknown> = {}) => {
  const replies: unknown[] = [];
  const sends: unknown[] = [];
  let typingCalls = 0;

  const message = {
    id: "message-1",
    guildId: "guild-1",
    channelId: "channel-1",
    content: "hello",
    webhookId: null,
    system: false,
    type: MessageType.Default,
    author: {
      id: "user-1",
      username: "User One",
      bot: false,
    },
    attachments: {
      size: 0,
      map: () => [],
    },
    channel: {
      sendTyping: async () => {
        typingCalls += 1;
      },
      send: async (payload: unknown) => {
        sends.push(payload);
      },
    },
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
    ...overrides,
  } as any;

  return {
    message,
    replies,
    sends,
    get typingCalls() {
      return typingCalls;
    },
  };
};

test("all_messages binding matches a normal user message", async () => {
  const fixture = createMessage();
  let asked = false;

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined } as any,
    findBinding: async () => createBinding(),
    askAssistant: async (input) => {
      asked = true;
      assert.equal(input.question, "hello");
      assert.equal(input.discord.messageId, "message-1");
      assert.equal(input.discord.conversationId, "discord:guild-1:channel-1");
      return "hello back";
    },
  });

  assert.equal(asked, true);
  assert.equal(fixture.typingCalls, 1);
  assert.deepEqual(fixture.replies, [
    {
      content: "hello back",
      allowedMentions: { repliedUser: false },
    },
  ]);
});

test("slash_only binding ignores a normal user message", async () => {
  const fixture = createMessage();

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined } as any,
    findBinding: async () => null,
    askAssistant: async () => {
      throw new Error("should not be called");
    },
  });

  assert.equal(fixture.typingCalls, 0);
  assert.equal(fixture.replies.length, 0);
});

test("disabled binding ignores a normal user message", async () => {
  const fixture = createMessage();

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined } as any,
    findBinding: async () => null,
    askAssistant: async () => {
      throw new Error("should not be called");
    },
  });

  assert.equal(fixture.replies.length, 0);
});

test("unbound channel is ignored", async () => {
  const fixture = createMessage();

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined } as any,
    findBinding: async () => null,
    askAssistant: async () => {
      throw new Error("should not be called");
    },
  });

  assert.equal(fixture.replies.length, 0);
});

test("bot messages are ignored", () => {
  assert.equal(
    shouldIgnoreDiscordMessage(
      createMessage({ author: { id: "bot-1", bot: true } }).message,
      "bot-1",
    ),
    true,
  );
});

test("webhook messages are ignored", () => {
  assert.equal(
    shouldIgnoreDiscordMessage(createMessage({ webhookId: "webhook-1" }).message),
    true,
  );
});

test("attachment-only messages are no longer ignored", () => {
  assert.equal(
    shouldIgnoreDiscordMessage(
      createMessage({
        content: "",
        attachments: { size: 1 },
      }).message,
    ),
    false,
  );
});

test("empty messages without attachments are still ignored", () => {
  assert.equal(
    shouldIgnoreDiscordMessage(
      createMessage({
        content: "   ",
        attachments: { size: 0 },
      }).message,
    ),
    true,
  );
});

test("duplicate message IDs are ignored by the processed cache", () => {
  const cache = createTtlMessageCache();

  assert.equal(cache.has("message-1"), false);
  cache.add("message-1");
  assert.equal(cache.has("message-1"), true);
});

test("runtime failures return a safe Discord error", async () => {
  const fixture = createMessage();
  const logged: unknown[] = [];

  await handleDiscordMessage(fixture.message, {
    logger: { error: (_message: string, metadata: unknown) => logged.push(metadata) } as any,
    findBinding: async () => createBinding(),
    askAssistant: async () => {
      throw new Error("secret runtime stack trace");
    },
  });

  assert.equal(logged.length, 1);
  assert.deepEqual(fixture.replies, [
    {
      content:
        "The assistant could not respond right now. Please try again shortly.",
      allowedMentions: { repliedUser: false },
    },
  ]);
});

test("long replies are split safely", async () => {
  const fixture = createMessage();
  const longAnswer = "a".repeat(4001);

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined } as any,
    findBinding: async () => createBinding(),
    askAssistant: async () => longAnswer,
  });

  assert.equal(fixture.replies.length, 1);
  assert.equal((fixture.replies[0] as any).content.length, 1900);
  assert.equal(fixture.sends.length, 2);
  assert.equal((fixture.sends[0] as any).content.length, 1900);
  assert.equal((fixture.sends[1] as any).content.length, 201);
  assert.equal(splitDiscordMessage(longAnswer).join(""), longAnswer);
});

test("existing slash command mode remains represented by slash_only default", () => {
  const binding = createBinding({ responseMode: undefined });
  assert.equal(binding.responseMode ?? "slash_only", "slash_only");
});

test("thread messages resolve the parent channel binding and a thread conversation id", async () => {
  const fixture = createMessage({
    channelId: "thread-1",
    channel: {
      isThread: () => true,
      parentId: "channel-1",
      name: "deal-discussion",
      parent: { name: "sales" },
      sendTyping: async () => undefined,
      send: async () => undefined,
    },
  });
  const lookups: Array<{ guildId: string; channelId: string }> = [];

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined } as any,
    findBinding: async (input) => {
      lookups.push(input);
      return input.channelId === "channel-1" ? createBinding() : null;
    },
    askAssistant: async (input) => {
      assert.equal(input.discord.channelId, "channel-1");
      assert.equal(input.discord.threadId, "thread-1");
      assert.equal(input.discord.threadName, "deal-discussion");
      assert.equal(input.discord.channelName, "sales");
      assert.equal(
        input.discord.conversationId,
        "discord:guild-1:channel-1:thread-1",
      );
      return "thread reply";
    },
  });

  assert.deepEqual(lookups, [{ guildId: "guild-1", channelId: "channel-1" }]);
  assert.equal(fixture.replies.length, 1);
});

test("discord context metadata is forwarded to the assistant", async () => {
  const fixture = createMessage({
    guild: { name: "Office Next" },
    member: { displayName: "MJ" },
    channel: {
      name: "sales",
      sendTyping: async () => undefined,
      send: async () => undefined,
    },
  });

  await handleDiscordMessage(fixture.message, {
    logger: { error: () => undefined } as any,
    findBinding: async () => createBinding(),
    askAssistant: async (input) => {
      assert.equal(input.discord.guildName, "Office Next");
      assert.equal(input.discord.channelName, "sales");
      assert.equal(input.discord.authorDisplayName, "MJ");
      assert.equal(input.discord.responseMode, "all_messages");
      assert.equal(input.discord.threadId, undefined);
      return "ok";
    },
  });

  assert.equal(fixture.replies.length, 1);
});

test("buildDiscordConversationId is stable for channels and threads", () => {
  assert.equal(
    buildDiscordConversationId({ guildId: "g", channelId: "c" }),
    "discord:g:c",
  );
  assert.equal(
    buildDiscordConversationId({ guildId: "g", channelId: "c", threadId: "t" }),
    "discord:g:c:t",
  );
});

import {
  Client,
  Events,
  GatewayIntentBits,
  MessageType,
  Partials,
  type Message,
} from "discord.js";

import { env, requireEnv } from "../config/env.js";
import { logger } from "../lib/logger.js";
import {
  DiscordAssistantBinding,
  type DiscordAssistantBindingDocument,
} from "../models/DiscordAssistantBinding.js";
import { askOpenClawAssistant } from "../openclaw/client.js";

type AttachmentMetadata = {
  id: string;
  filename: string;
  contentType?: string | null;
  size: number;
  url: string;
};

type MessageGatewayStatus = {
  enabled: boolean;
  connected: boolean;
};

type MessageGatewayDeps = {
  findBinding: (input: {
    guildId: string;
    channelId: string;
  }) => Promise<DiscordAssistantBindingDocument | null>;
  askAssistant: typeof askOpenClawAssistant;
  logger: typeof logger;
};

type SendableDiscordChannel = {
  sendTyping: () => Promise<void>;
  send: (payload: {
    content: string;
    allowedMentions: { repliedUser: false };
  }) => Promise<unknown>;
};

const DISCORD_MESSAGE_LIMIT = 2000;
const DEFAULT_REPLY_CHUNK_LIMIT = 1900;
const PROCESSED_MESSAGE_TTL_MS = 5 * 60 * 1000;
const PROCESSED_MESSAGE_MAX_SIZE = 5000;

const status: MessageGatewayStatus = {
  enabled: env.DISCORD_MESSAGE_GATEWAY_ENABLED === "true",
  connected: false,
};

let startedClient: Client | null = null;

export const getDiscordMessageGatewayStatus = () => ({ ...status });

export const createTtlMessageCache = (
  ttlMs = PROCESSED_MESSAGE_TTL_MS,
  maxSize = PROCESSED_MESSAGE_MAX_SIZE,
) => {
  const processed = new Map<string, number>();

  const prune = (now = Date.now()) => {
    for (const [messageId, expiresAt] of processed.entries()) {
      if (expiresAt <= now || processed.size > maxSize) {
        processed.delete(messageId);
      }
    }
  };

  return {
    has(messageId: string) {
      prune();
      return processed.has(messageId);
    },
    add(messageId: string) {
      prune();
      processed.set(messageId, Date.now() + ttlMs);
    },
    size() {
      prune();
      return processed.size;
    },
  };
};

export const createPerChannelQueue = () => {
  const queues = new Map<string, Promise<void>>();

  const enqueue = (key: string, task: () => Promise<void>) => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {
        // Previous failures are already logged by the task.
      })
      .then(task)
      .finally(() => {
        if (queues.get(key) === next) {
          queues.delete(key);
        }
      });

    queues.set(key, next);
    return next;
  };

  return { enqueue };
};

export const splitDiscordMessage = (
  input: string,
  limit = DEFAULT_REPLY_CHUNK_LIMIT,
) => {
  const text = input.trim() || "The assistant returned an empty response.";

  if (limit <= 0 || limit > DISCORD_MESSAGE_LIMIT) {
    throw new Error("Invalid Discord message split limit");
  }

  const chunks: string[] = [];
  let current = "";

  for (const char of text) {
    if (current.length + char.length > limit) {
      chunks.push(current);
      current = "";
    }

    current += char;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
};

const isSystemMessage = (message: Pick<Message, "system" | "type">) =>
  Boolean(message.system) || message.type !== MessageType.Default;

export const shouldIgnoreDiscordMessage = (
  message: Pick<
    Message,
    "guildId" | "channelId" | "content" | "webhookId" | "system" | "type"
  > & {
    id: string;
    author?: { bot?: boolean; id?: string };
    attachments?: { size?: number };
  },
  clientUserId?: string,
) => {
  if (!message.guildId || !message.channelId) {
    return true;
  }

  if (message.author?.bot || message.webhookId) {
    return true;
  }

  if (clientUserId && message.author?.id === clientUserId) {
    return true;
  }

  if (isSystemMessage(message as Pick<Message, "system" | "type">)) {
    return true;
  }

  if (!message.content.trim()) {
    return true;
  }

  return false;
};

const getAttachmentMetadata = (message: Message): AttachmentMetadata[] =>
  message.attachments.map((attachment) => ({
    id: attachment.id,
    filename: attachment.name,
    contentType: attachment.contentType,
    size: attachment.size,
    url: attachment.url,
  }));

export const handleDiscordMessage = async (
  message: Message,
  deps: MessageGatewayDeps,
) => {
  const guildId = message.guildId;
  const channelId = message.channelId;

  if (!guildId || !channelId) {
    return;
  }

  const binding = await deps.findBinding({ guildId, channelId });

  if (!binding) {
    return;
  }

  const channel = message.channel as Partial<SendableDiscordChannel>;

  if (
    typeof channel.sendTyping !== "function" ||
    typeof channel.send !== "function"
  ) {
    deps.logger.error("Discord message handling failed", {
      guildId,
      channelId,
      messageId: message.id,
      assistantId: binding.assistantId,
      error: "Discord channel is not sendable",
    });
    return;
  }

  try {
    await channel.sendTyping();

    const answer = await deps.askAssistant({
      openclawUrl: binding.openclawUrl,
      tenantId: binding.tenantId,
      assistantId: binding.assistantId,
      question: message.content.trim(),
      user: {
        id: message.author.id,
        username: message.author.username,
      },
      discord: {
        guildId,
        channelId,
        messageId: message.id,
        userId: message.author.id,
        username: message.author.username,
        conversationId: `discord:${guildId}:${channelId}`,
        attachments: getAttachmentMetadata(message),
      },
    });

    const [firstChunk, ...remainingChunks] = splitDiscordMessage(answer);

    await message.reply({
      content: firstChunk,
      allowedMentions: { repliedUser: false },
    });

    for (const chunk of remainingChunks) {
      await channel.send({
        content: chunk,
        allowedMentions: { repliedUser: false },
      });
    }
  } catch (error) {
    deps.logger.error("Discord message handling failed", {
      guildId,
      channelId,
      messageId: message.id,
      assistantId: binding.assistantId,
      error: error instanceof Error ? error.message : String(error),
    });

    await message
      .reply({
        content:
          "The assistant could not respond right now. Please try again shortly.",
        allowedMentions: { repliedUser: false },
      })
      .catch((replyError) => {
        deps.logger.error("Failed to send Discord message error response", {
          guildId,
          channelId,
          messageId: message.id,
          error:
            replyError instanceof Error
              ? replyError.message
              : String(replyError),
        });
      });
  }
};

export const startDiscordMessageGateway = async () => {
  status.enabled = env.DISCORD_MESSAGE_GATEWAY_ENABLED === "true";

  if (!status.enabled) {
    return null;
  }

  if (startedClient) {
    return startedClient;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });
  const processedMessages = createTtlMessageCache();
  const channelQueue = createPerChannelQueue();

  client.once(Events.ClientReady, () => {
    status.connected = true;
    logger.info("Discord message gateway connected");
  });

  client.on(Events.ShardDisconnect, (event) => {
    status.connected = false;
    logger.warn("Discord message gateway disconnected", {
      code: event.code,
      reason: event.reason,
    });
  });

  client.on(Events.Error, (error) => {
    logger.error("Discord message gateway error", {
      error: error.message,
    });
  });

  client.on(Events.MessageCreate, (message) => {
    if (shouldIgnoreDiscordMessage(message, client.user?.id)) {
      return;
    }

    if (processedMessages.has(message.id)) {
      return;
    }

    processedMessages.add(message.id);

    const guildId = message.guildId;
    const channelId = message.channelId;

    if (!guildId || !channelId) {
      return;
    }

    void channelQueue.enqueue(`${guildId}:${channelId}`, () =>
      handleDiscordMessage(message, {
        logger,
        askAssistant: askOpenClawAssistant,
        findBinding: ({ guildId: nextGuildId, channelId: nextChannelId }) =>
          DiscordAssistantBinding.findOne({
            discordGuildId: nextGuildId,
            discordChannelId: nextChannelId,
            enabled: true,
            responseMode: "all_messages",
          }),
      }),
    );
  });

  startedClient = client;

  try {
    await client.login(requireEnv("DISCORD_BOT_TOKEN"));
  } catch (error) {
    startedClient = null;
    status.connected = false;

    logger.error("Discord message gateway login failed", {
      error: error instanceof Error ? error.message : String(error),
    });

    throw error;
  }

  return client;
};

export const stopDiscordMessageGateway = async () => {
  if (!startedClient) {
    status.connected = false;
    return;
  }

  const client = startedClient;
  startedClient = null;
  status.connected = false;
  client.destroy();
  logger.info("Discord message gateway disconnected");
};

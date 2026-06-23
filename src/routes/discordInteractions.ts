import { Router } from "express";

import { verifyDiscordRequest, type DiscordRequest } from "../discord/verifyDiscordRequest.js";
import {
  getQuestionFromInteraction,
  getDiscordUser,
  InteractionResponseType,
  InteractionType,
  type DiscordInteraction,
} from "../discord/interactions.js";
import {
  createFollowupMessage,
  editOriginalInteractionResponse,
} from "../discord/respond.js";
import { sendChannelMessage } from "../discord/api.js";
import { launchDiscordLongOperationJob } from "../discord/longJobLauncher.js";
import { detectLongRunningOperation } from "../discord/longOps.js";
import {
  detectProtectedFileRequest,
  guardOutboundText,
  SECRET_REFUSAL_MESSAGE,
} from "../security/secretGuard.js";
import {
  askOpenClawAssistant,
  downloadRuntimeGeneratedFile,
} from "../openclaw/client.js";
import { DiscordAssistantBinding } from "../models/DiscordAssistantBinding.js";
import { logger } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { env } from "../config/env.js";
import {
  buildDiscordConversationId,
  buildRuntimeFilePayloads,
  splitDiscordMessage,
} from "../discord/messageGateway.js";

export const discordInteractionsRouter = Router();

const mappedChannelMessage = (guildId: string, channelId: string) =>
  [
    "Erxes AI Assistant is installed, but this channel is not connected to an assistant yet.",
    "",
    `Guild ID: ${guildId}`,
    `Channel ID: ${channelId}`,
    "",
    "Connect this channel from Erxes Admin.",
  ].join("\n");

discordInteractionsRouter.post(
  "/",
  verifyDiscordRequest,
  asyncHandler(async (req, res) => {
    const interaction = (req as DiscordRequest)
      .discordInteraction as DiscordInteraction;

    if (interaction.type === InteractionType.PING) {
      res.json({ type: InteractionResponseType.PONG });
      return;
    }

    if (interaction.type !== InteractionType.APPLICATION_COMMAND) {
      res.status(400).json({ error: "Unsupported interaction type" });
      return;
    }

    const question = getQuestionFromInteraction(interaction);

    if (!question) {
      res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content:
            "Use `/assistant question:<text>` to ask an Erxes AI Assistant.",
          flags: 64,
        },
      });
      return;
    }

    const guildId = interaction.guild_id;
    const channelId = interaction.channel_id;

    if (!guildId || !channelId) {
      res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content:
            "This command must be used in a Discord server channel mapped to an Erxes AI Assistant.",
          flags: 64,
        },
      });
      return;
    }

    const DISCORD_THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);
    const interactionChannel = interaction.channel;
    const isThread =
      interactionChannel?.type !== undefined &&
      DISCORD_THREAD_CHANNEL_TYPES.has(interactionChannel.type) &&
      Boolean(interactionChannel.parent_id);
    const bindingChannelId =
      isThread && interactionChannel?.parent_id
        ? interactionChannel.parent_id
        : channelId;
    const threadId = isThread ? channelId : undefined;

    const binding = await DiscordAssistantBinding.findOne({
      discordGuildId: guildId,
      discordChannelId: bindingChannelId,
      enabled: true,
    });

    if (!binding) {
      res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: mappedChannelMessage(guildId, channelId),
          flags: 64,
        },
      });
      return;
    }

    // Layer 1: deny protected-file/config disclosure requests before OpenClaw.
    const inboundDetection = detectProtectedFileRequest(question);
    if (inboundDetection.blocked) {
      logger.info("Discord slash protected-file request denied", {
        interactionId: interaction.id,
        guildId,
        channelId,
        category: inboundDetection.category,
      });
      res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: SECRET_REFUSAL_MESSAGE, flags: 64 },
      });
      return;
    }

    res.json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    });

    const user = getDiscordUser(interaction);
    const opType = detectLongRunningOperation(question);

    if (opType) {
      const conversationId = buildDiscordConversationId({
        guildId,
        channelId: bindingChannelId,
        threadId,
      });

      await editOriginalInteractionResponse({
        applicationId: interaction.application_id,
        interactionToken: interaction.token,
        content: "Started. I'll post progress here.",
      }).catch(() => undefined);

      void launchDiscordLongOperationJob({
        opType,
        ask: {
          openclawUrl: binding.openclawUrl,
          tenantId: binding.tenantId,
          assistantId: binding.assistantId,
          question,
          user,
          discord: {
            guildId,
            channelId: bindingChannelId,
            guildName: interaction.guild?.name,
            channelName: isThread ? undefined : interactionChannel?.name,
            threadId,
            threadName: isThread ? interactionChannel?.name : undefined,
            userId: user.id,
            username: user.username,
            responseMode: binding.responseMode,
            conversationId,
          },
        },
        messageId: interaction.id,
        conversationId,
        guildId,
        channelId: bindingChannelId,
        threadId,
        skipAck: true,
        // Interaction tokens expire after 15 minutes; stop polling before that.
        timeoutMs: Math.min(env.ASSISTANT_JOB_TIMEOUT_MS, 13 * 60_000),
        ack: async () => undefined,
        notify: async (content: string) => {
          try {
            return await createFollowupMessage({
              applicationId: interaction.application_id,
              interactionToken: interaction.token,
              content,
            });
          } catch (followupError) {
            // The interaction webhook token is the only fragile delivery
            // surface (it expires / can fail late). Fall back to a normal bot
            // channel message so the answer still reaches the channel.
            logger.error(
              "Discord slash follow-up failed; falling back to channel message",
              {
                interactionId: interaction.id,
                guildId,
                channelId,
                error:
                  followupError instanceof Error
                    ? followupError.message
                    : String(followupError),
              },
            );
            return await sendChannelMessage(channelId, content);
          }
        },
        sendFiles: (caption, files) =>
          createFollowupMessage({
            applicationId: interaction.application_id,
            interactionToken: interaction.token,
            content: caption,
            files,
          }),
      }).catch((error) => {
        logger.error("Discord slash long operation job failed to start", {
          interactionId: interaction.id,
          guildId,
          channelId,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      return;
    }

    try {
      const result = await askOpenClawAssistant({
        openclawUrl: binding.openclawUrl,
        tenantId: binding.tenantId,
        assistantId: binding.assistantId,
        question,
        user,
        discord: {
          guildId,
          channelId: bindingChannelId,
          guildName: interaction.guild?.name,
          channelName: isThread ? undefined : interactionChannel?.name,
          threadId,
          threadName: isThread ? interactionChannel?.name : undefined,
          userId: user.id,
          username: user.username,
          responseMode: binding.responseMode,
          conversationId: buildDiscordConversationId({
            guildId,
            channelId: bindingChannelId,
            threadId,
          }),
        },
      });

      // Layer 3: guard outbound text before sending.
      const guardedAnswer = guardOutboundText(result.answer).text;

      await editOriginalInteractionResponse({
        applicationId: interaction.application_id,
        interactionToken: interaction.token,
        content: splitDiscordMessage(
          guardedAnswer,
          env.ERXES_ASSISTANT_REPLY_MAX_CHARS,
        )[0] ?? "The assistant returned an empty response.",
      });

      if (result.files.length > 0) {
        const { payloads, failed, blocked } = await buildRuntimeFilePayloads(
          binding.openclawUrl,
          result.files,
          downloadRuntimeGeneratedFile,
        );

        if (payloads.length > 0) {
          await createFollowupMessage({
            applicationId: interaction.application_id,
            interactionToken: interaction.token,
            content: "Here is the generated file.",
            files: payloads,
          }).catch(() => undefined);
        }

        if (blocked.length > 0) {
          await createFollowupMessage({
            applicationId: interaction.application_id,
            interactionToken: interaction.token,
            content: SECRET_REFUSAL_MESSAGE,
          }).catch(() => undefined);
        }

        if (failed.length > 0 || (payloads.length === 0 && blocked.length === 0)) {
          await createFollowupMessage({
            applicationId: interaction.application_id,
            interactionToken: interaction.token,
            content: "I created the file, but couldn't upload it to Discord.",
          }).catch(() => undefined);
        }
      }
    } catch (error) {
      logger.error("Failed to answer Discord interaction", {
        interactionId: interaction.id,
        guildId,
        channelId,
        error: error instanceof Error ? error.message : String(error),
      });

      await editOriginalInteractionResponse({
        applicationId: interaction.application_id,
        interactionToken: interaction.token,
        content:
          "Erxes AI Assistant could not answer right now. Please try again later.",
      }).catch((editError) => {
        logger.error("Failed to send Discord error response", {
          interactionId: interaction.id,
          error:
            editError instanceof Error ? editError.message : String(editError),
        });
      });
    }
  }),
);

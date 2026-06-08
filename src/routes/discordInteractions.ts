import { Router } from "express";

import { verifyDiscordRequest, type DiscordRequest } from "../discord/verifyDiscordRequest.js";
import {
  getQuestionFromInteraction,
  getDiscordUser,
  InteractionResponseType,
  InteractionType,
  type DiscordInteraction,
} from "../discord/interactions.js";
import { editOriginalInteractionResponse } from "../discord/respond.js";
import { askOpenClawAssistant } from "../openclaw/client.js";
import { DiscordAssistantBinding } from "../models/DiscordAssistantBinding.js";
import { logger } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { env } from "../config/env.js";
import { splitDiscordMessage } from "../discord/messageGateway.js";

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

    const binding = await DiscordAssistantBinding.findOne({
      discordGuildId: guildId,
      discordChannelId: channelId,
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

    res.json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    });

    const user = getDiscordUser(interaction);

    try {
      const answer = await askOpenClawAssistant({
        openclawUrl: binding.openclawUrl,
        tenantId: binding.tenantId,
        assistantId: binding.assistantId,
        question,
        user,
        discord: {
          guildId,
          channelId,
        },
      });

      await editOriginalInteractionResponse({
        applicationId: interaction.application_id,
        interactionToken: interaction.token,
        content: splitDiscordMessage(
          answer,
          env.ERXES_ASSISTANT_REPLY_MAX_CHARS,
        )[0] ?? "The assistant returned an empty response.",
      });
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

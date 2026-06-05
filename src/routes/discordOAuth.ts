import { Router } from "express";

import { asyncHandler } from "../lib/asyncHandler.js";
import { badRequest } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { createSecureState } from "../lib/crypto.js";
import {
  appendDiscordConnectionResult,
  buildDiscordInstallUrl,
  errorHtml,
  missingGuildHtml,
  successHtml,
  validateReturnUrl,
} from "../discord/oauth.js";
import { discordOAuthScopes } from "../discord/oauth.js";
import {
  exchangeDiscordOAuthCode,
  getDiscordGuild,
  getDiscordOAuthMe,
} from "../discord/api.js";
import { OAuthState } from "../models/OAuthState.js";
import { DiscordInstallation } from "../models/DiscordInstallation.js";

export const discordOAuthRouter = Router();

const getQueryString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

discordOAuthRouter.get(
  "/start",
  asyncHandler(async (req, res) => {
    const tenantId = getQueryString(req.query.tenantId);
    const returnUrl = getQueryString(req.query.returnUrl);

    if (!tenantId) {
      throw badRequest("tenantId is required");
    }

    const validatedReturnUrl = validateReturnUrl(returnUrl);

    if (returnUrl && !validatedReturnUrl) {
      throw badRequest("returnUrl is not allowed");
    }

    const state = createSecureState();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await OAuthState.create({
      state,
      tenantId,
      assistantId: getQueryString(req.query.assistantId),
      erxesUserId: getQueryString(req.query.erxesUserId),
      returnUrl: validatedReturnUrl,
      expiresAt,
    });

    res.redirect(buildDiscordInstallUrl(state));
  }),
);

discordOAuthRouter.get(
  "/callback",
  asyncHandler(async (req, res) => {
    const state = getQueryString(req.query.state);

    if (!state) {
      throw badRequest("state is required");
    }

    const oauthState = await OAuthState.findOneAndUpdate(
      {
        state,
        usedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      },
      { $set: { usedAt: new Date() } },
      { new: true },
    );

    if (!oauthState) {
      throw badRequest("Invalid or expired OAuth state");
    }

    let guildId = getQueryString(req.query.guild_id);
    let guildName = getQueryString(req.query.guild_name);
    let installedByDiscordUserId: string | undefined;
    const permissions = getQueryString(req.query.permissions);
    const code = getQueryString(req.query.code);

    if (code) {
      try {
        const token = await exchangeDiscordOAuthCode(code);

        if (token.access_token) {
          const oauthMe = await getDiscordOAuthMe(token.access_token);
          installedByDiscordUserId = oauthMe.user?.id;
          guildId = guildId ?? oauthMe.guild?.id;
          guildName = guildName ?? oauthMe.guild?.name;
        }
      } catch (error) {
        logger.warn("Discord OAuth code exchange failed", {
          hasGuildId: !!guildId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!guildId) {
      logger.warn("Discord OAuth callback did not include guild_id", {
        queryKeys: Object.keys(req.query),
        hasCode: !!code,
      });

      if (oauthState.returnUrl) {
        res.redirect(
          appendDiscordConnectionResult(oauthState.returnUrl, {
            status: "error",
            message: "missing-discord-guild",
          }),
        );
        return;
      }

      res.status(200).type("html").send(missingGuildHtml());
      return;
    }

    try {
      const guild = await getDiscordGuild(guildId);
      guildName = guildName ?? guild.name;
    } catch (error) {
      logger.warn("Could not load Discord guild after install", {
        guildId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const installation = await DiscordInstallation.findOneAndUpdate(
      {
        tenantId: oauthState.tenantId,
        discordGuildId: guildId,
      },
      {
        tenantId: oauthState.tenantId,
        assistantId: oauthState.assistantId,
        discordGuildId: guildId,
        discordGuildName: guildName,
        installedByDiscordUserId,
        installedByErxesUserId: oauthState.erxesUserId,
        status: "connected",
        scopes: [...discordOAuthScopes],
        permissions,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    if (oauthState.returnUrl) {
      res.redirect(
        appendDiscordConnectionResult(oauthState.returnUrl, {
          status: "success",
          installationId: installation._id.toString(),
        }),
      );
      return;
    }

    res.status(200).type("html").send(successHtml());
  }),
);

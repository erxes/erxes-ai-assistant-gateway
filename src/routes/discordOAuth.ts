import { Router, type Response } from "express";

import { asyncHandler } from "../lib/asyncHandler.js";
import { badRequest } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { createSecureState } from "../lib/crypto.js";
import {
  appendDiscordConnectionResult,
  buildDiscordInstallUrl,
  errorHtml,
  successHtml,
  validateReturnUrl,
} from "../discord/oauth.js";
import { discordOAuthScopes } from "../discord/oauth.js";
import { hasAdministratorPermission } from "../discord/permissions.js";
import {
  exchangeDiscordOAuthCode,
  getDiscordGuild,
  getDiscordOAuthMe,
  type DiscordGuild,
  type DiscordOAuthMeResponse,
  type DiscordOAuthTokenResponse,
} from "../discord/api.js";
import { OAuthState } from "../models/OAuthState.js";
import { DiscordInstallation } from "../models/DiscordInstallation.js";

type OAuthStateRecord = {
  tenantId: string;
  assistantId?: string;
  erxesUserId?: string;
  returnUrl?: string;
};

type OAuthStateModel = {
  create: (doc: Record<string, unknown>) => Promise<unknown>;
  findOneAndUpdate: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<OAuthStateRecord | null>;
};

type DiscordInstallationModel = {
  findOneAndUpdate: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<{ _id: { toString: () => string } }>;
};

type DiscordOAuthRouterDeps = {
  OAuthStateModel: OAuthStateModel;
  DiscordInstallationModel: DiscordInstallationModel;
  exchangeDiscordOAuthCode: (
    code: string,
  ) => Promise<DiscordOAuthTokenResponse>;
  getDiscordOAuthMe: (accessToken: string) => Promise<DiscordOAuthMeResponse>;
  getDiscordGuild: (guildId: string) => Promise<DiscordGuild>;
};

const getQueryString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const sendOAuthError = (res: Response, returnUrl: string | undefined, message: string) => {
  if (returnUrl) {
    res.redirect(
      appendDiscordConnectionResult(returnUrl, {
        status: "error",
        message,
      }),
    );
    return;
  }

  res.status(400).type("html").send(errorHtml(message));
};

export const createDiscordOAuthRouter = ({
  OAuthStateModel,
  DiscordInstallationModel,
  exchangeDiscordOAuthCode: exchangeCode,
  getDiscordOAuthMe: getOAuthMe,
  getDiscordGuild: getGuild,
}: DiscordOAuthRouterDeps) => {
  const router = Router();

  router.get(
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

      await OAuthStateModel.create({
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

  router.get(
    "/callback",
    asyncHandler(async (req, res) => {
      const state = getQueryString(req.query.state);

      if (!state) {
        throw badRequest("state is required");
      }

      const oauthState = await OAuthStateModel.findOneAndUpdate(
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

      const permissions = getQueryString(req.query.permissions);
      const code = getQueryString(req.query.code);

      if (!code) {
        logger.warn("Discord OAuth callback missing code", {
          queryKeys: Object.keys(req.query),
        });
        sendOAuthError(res, oauthState.returnUrl, "missing-oauth-code");
        return;
      }

      if (!hasAdministratorPermission(permissions)) {
        logger.warn("Discord OAuth callback missing Administrator permission", {
          permissions,
        });
        sendOAuthError(
          res,
          oauthState.returnUrl,
          "missing-administrator-permission",
        );
        return;
      }

      let token: DiscordOAuthTokenResponse;

      try {
        token = await exchangeCode(code);
      } catch (error) {
        logger.warn("Discord OAuth code exchange failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        sendOAuthError(res, oauthState.returnUrl, "discord-oauth-exchange-failed");
        return;
      }

      if (!token.access_token) {
        logger.warn("Discord OAuth code exchange did not return access token");
        sendOAuthError(res, oauthState.returnUrl, "missing-discord-access-token");
        return;
      }

      let oauthMe: DiscordOAuthMeResponse;

      try {
        oauthMe = await getOAuthMe(token.access_token);
      } catch (error) {
        logger.warn("Could not load Discord OAuth installation details", {
          error: error instanceof Error ? error.message : String(error),
        });
        sendOAuthError(
          res,
          oauthState.returnUrl,
          "discord-install-details-unavailable",
        );
        return;
      }

      const guildId = oauthMe.guild?.id;

      if (!guildId) {
        logger.warn("Discord OAuth installation details missing guild");
        sendOAuthError(res, oauthState.returnUrl, "missing-discord-guild");
        return;
      }

      let guild: DiscordGuild;

      try {
        guild = await getGuild(guildId);
      } catch (error) {
        logger.warn("Bot cannot access Discord guild after install", {
          guildId,
          error: error instanceof Error ? error.message : String(error),
        });
        sendOAuthError(res, oauthState.returnUrl, "discord-guild-inaccessible");
        return;
      }

      const installation = await DiscordInstallationModel.findOneAndUpdate(
        {
          tenantId: oauthState.tenantId,
          discordGuildId: guildId,
        },
        {
          tenantId: oauthState.tenantId,
          assistantId: oauthState.assistantId,
          discordGuildId: guildId,
          discordGuildName: oauthMe.guild?.name ?? guild.name,
          installedByDiscordUserId: oauthMe.user?.id,
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

  return router;
};

export const discordOAuthRouter = createDiscordOAuthRouter({
  OAuthStateModel: OAuthState,
  DiscordInstallationModel: DiscordInstallation,
  exchangeDiscordOAuthCode,
  getDiscordOAuthMe,
  getDiscordGuild,
});

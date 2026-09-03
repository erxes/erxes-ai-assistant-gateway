import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Response } from "express";

import { env } from "../config/env.js";
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
import { hasRequiredBotPermissions } from "../discord/permissions.js";
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

const oauthStartPayload = (claims: {
  tenantId: string;
  assistantId?: string;
  erxesUserId?: string;
  returnUrl?: string;
  expiresAt: string;
}) =>
  [
    claims.tenantId,
    claims.assistantId || "",
    claims.erxesUserId || "",
    claims.returnUrl || "",
    claims.expiresAt,
  ].join("\n");

export const validateOAuthStartSignature = (
  claims: Parameters<typeof oauthStartPayload>[0],
  signature: string | undefined,
  secret = env.ERXES_GATEWAY_ADMIN_SECRET,
) => {
  const expiresAt = Number(claims.expiresAt);
  const now = Math.floor(Date.now() / 1000);
  if (
    !signature ||
    !secret ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + 15 * 60
  ) {
    return false;
  }

  const expected = createHmac("sha256", secret)
    .update(oauthStartPayload(claims))
    .digest("hex");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
};

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
      const assistantId = getQueryString(req.query.assistantId);
      const erxesUserId = getQueryString(req.query.erxesUserId);
      const claimsExpiresAt = getQueryString(req.query.expiresAt);
      const signature = getQueryString(req.query.signature);

      if (!tenantId || !claimsExpiresAt) {
        throw badRequest("signed OAuth start claims are required");
      }

      const validatedReturnUrl = validateReturnUrl(returnUrl);

      if (returnUrl && !validatedReturnUrl) {
        throw badRequest("returnUrl is not allowed");
      }

      if (
        !validateOAuthStartSignature(
          {
            tenantId,
            assistantId,
            erxesUserId,
            returnUrl: validatedReturnUrl,
            expiresAt: claimsExpiresAt,
          },
          signature,
        )
      ) {
        throw badRequest("invalid or expired OAuth start signature");
      }

      const state = createSecureState();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await OAuthStateModel.create({
        state,
        tenantId,
        assistantId,
        erxesUserId,
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

      if (!hasRequiredBotPermissions(permissions)) {
        logger.warn("Discord OAuth callback missing required bot permissions", {
          permissions,
        });
        sendOAuthError(
          res,
          oauthState.returnUrl,
          "missing-required-bot-permissions",
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

      const callbackGuildId = getQueryString(req.query.guild_id);
      const guildId = token.guild?.id;

      if (!guildId) {
        logger.warn("Discord OAuth token response missing installed guild");
        sendOAuthError(res, oauthState.returnUrl, "missing-discord-guild");
        return;
      }

      if (callbackGuildId && callbackGuildId !== guildId) {
        logger.warn("Discord OAuth callback guild did not match token response", {
          callbackGuildId,
          tokenGuildId: guildId,
        });
        sendOAuthError(res, oauthState.returnUrl, "discord-guild-mismatch");
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
          $set: {
            tenantId: oauthState.tenantId,
            discordGuildId: guildId,
            discordGuildName: token.guild?.name ?? guild.name,
            installedByDiscordUserId: oauthMe.user?.id,
            installedByErxesUserId: oauthState.erxesUserId,
            status: "connected",
            scopes: [...discordOAuthScopes],
            permissions,
          },
          // assistantId was stored by older versions even though the official
          // bot installation is shared by every assistant in the tenant.
          $unset: { assistantId: 1 },
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

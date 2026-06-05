import { Router } from "express";
import mongoose from "mongoose";

import { getDiscordGuildChannels } from "../discord/api.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { badRequest, notFound } from "../lib/errors.js";
import { DiscordInstallation } from "../models/DiscordInstallation.js";
import { requireAdminSecret } from "./adminAuth.js";

export const adminInstallationsRouter = Router();

const getQueryString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const textChannelTypes = new Set([0, 5]);

adminInstallationsRouter.use(requireAdminSecret);

adminInstallationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query: Record<string, unknown> = {};

    for (const field of ["tenantId", "assistantId", "status"]) {
      const value = getQueryString(req.query[field]);

      if (value) {
        query[field] = value;
      }
    }

    const installations = await DiscordInstallation.find(query)
      .sort({ updatedAt: -1 })
      .limit(200);

    res.json({ installations });
  }),
);

adminInstallationsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw badRequest("Invalid installation id");
    }

    const installation = await DiscordInstallation.findById(req.params.id);

    if (!installation) {
      throw notFound("Installation not found");
    }

    res.json({ installation });
  }),
);

adminInstallationsRouter.get(
  "/:id/channels",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw badRequest("Invalid installation id");
    }

    const installation = await DiscordInstallation.findById(req.params.id);

    if (!installation) {
      throw notFound("Installation not found");
    }

    if (installation.status !== "connected") {
      throw badRequest("Discord installation is not connected");
    }

    const channels = await getDiscordGuildChannels(
      installation.discordGuildId,
    );

    res.json({
      channels: channels
        .filter((channel) => textChannelTypes.has(channel.type))
        .map((channel) => ({
          id: channel.id,
          name: channel.name ?? channel.id,
          type: channel.type,
          position: channel.position,
          parentId: channel.parent_id,
        }))
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    });
  }),
);

import { Router } from "express";
import mongoose from "mongoose";

import { asyncHandler } from "../lib/asyncHandler.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import {
  DiscordAssistantBinding,
  discordAssistantResponseModes,
  type DiscordAssistantResponseMode,
} from "../models/DiscordAssistantBinding.js";
import { DiscordInstallation } from "../models/DiscordInstallation.js";
import { requireAdminSecret } from "./adminAuth.js";

export const adminBindingsRouter = Router();

const requiredString = (body: Record<string, unknown>, field: string) => {
  const value = body[field];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`${field} is required`);
  }

  return value.trim();
};

const optionalString = (body: Record<string, unknown>, field: string) => {
  const value = body[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw badRequest(`${field} must be a string`);
  }

  return value.trim();
};

const parseResponseMode = (
  value: unknown,
): DiscordAssistantResponseMode | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== "string" ||
    !discordAssistantResponseModes.includes(
      value as DiscordAssistantResponseMode,
    )
  ) {
    throw badRequest("responseMode must be slash_only or all_messages");
  }

  return value as DiscordAssistantResponseMode;
};

const parseCreateBindingBody = (body: unknown) => {
  if (!body || typeof body !== "object") {
    throw badRequest("Request body must be an object");
  }

  const data = body as Record<string, unknown>;

  return {
    installationId: optionalString(data, "installationId"),
    tenantId: requiredString(data, "tenantId"),
    assistantId: requiredString(data, "assistantId"),
    assistantName: optionalString(data, "assistantName"),
    discordGuildId: requiredString(data, "discordGuildId"),
    discordChannelId: requiredString(data, "discordChannelId"),
    openclawUrl: requiredString(data, "openclawUrl"),
    enabled: typeof data.enabled === "boolean" ? data.enabled : true,
    responseMode: parseResponseMode(data.responseMode) ?? "slash_only",
  };
};

adminBindingsRouter.use(requireAdminSecret);

const loadConnectedInstallation = async ({
  installationId,
  tenantId,
  discordGuildId,
}: {
  installationId?: string;
  tenantId: string;
  discordGuildId: string;
}) => {
  if (installationId) {
    if (!mongoose.isValidObjectId(installationId)) {
      throw badRequest("Invalid installation id");
    }

    const installation = await DiscordInstallation.findById(installationId);

    if (!installation) {
      throw notFound("Installation not found");
    }

    if (
      installation.tenantId !== tenantId ||
      installation.discordGuildId !== discordGuildId
    ) {
      throw badRequest("Installation does not match tenant and Discord guild");
    }

    if (installation.status !== "connected") {
      throw badRequest("Discord installation is not connected");
    }

    return installation;
  }

  const installation = await DiscordInstallation.findOne({
    tenantId,
    discordGuildId,
    status: "connected",
  });

  if (!installation) {
    throw notFound("Connected Discord installation not found");
  }

  return installation;
};

const assertChannelAvailable = async ({
  discordGuildId,
  discordChannelId,
  bindingId,
}: {
  discordGuildId: string;
  discordChannelId: string;
  bindingId?: string;
}) => {
  const existing = await DiscordAssistantBinding.findOne({
    discordGuildId,
    discordChannelId,
    enabled: true,
    ...(bindingId ? { _id: { $ne: bindingId } } : {}),
  });

  if (existing) {
    throw conflict("Discord channel is already connected to an assistant");
  }
};

adminBindingsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = parseCreateBindingBody(req.body);

    await loadConnectedInstallation(input);
    await assertChannelAvailable(input);

    const binding = await DiscordAssistantBinding.findOneAndUpdate(
      {
        discordGuildId: input.discordGuildId,
        discordChannelId: input.discordChannelId,
      },
      {
        $set: {
          tenantId: input.tenantId,
          assistantId: input.assistantId,
          assistantName: input.assistantName,
          discordGuildId: input.discordGuildId,
          discordChannelId: input.discordChannelId,
          openclawUrl: input.openclawUrl,
          enabled: input.enabled,
          responseMode: input.responseMode,
        },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );

    res.status(201).json({ binding });
  }),
);

adminBindingsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query: Record<string, unknown> = {};

    for (const field of [
      "tenantId",
      "assistantId",
      "discordGuildId",
      "discordChannelId",
    ]) {
      const value = req.query[field];

      if (typeof value === "string" && value.trim().length > 0) {
        query[field] = value.trim();
      }
    }

    const bindings = await DiscordAssistantBinding.find(query)
      .sort({ createdAt: -1 })
      .limit(200);

    res.json({ bindings });
  }),
);

adminBindingsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw badRequest("Invalid binding id");
    }

    const binding = await DiscordAssistantBinding.findById(req.params.id);

    if (!binding) {
      throw notFound("Binding not found");
    }

    res.json({ binding });
  }),
);

adminBindingsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw badRequest("Invalid binding id");
    }

    if (!req.body || typeof req.body !== "object") {
      throw badRequest("Request body must be an object");
    }

    const data = req.body as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    const stringFields = [
      "tenantId",
      "assistantId",
      "assistantName",
      "discordGuildId",
      "discordChannelId",
      "openclawUrl",
    ];

    for (const field of stringFields) {
      if (data[field] !== undefined) {
        update[field] = optionalString(data, field);
      }
    }

    if (data.enabled !== undefined) {
      if (typeof data.enabled !== "boolean") {
        throw badRequest("enabled must be a boolean");
      }

      update.enabled = data.enabled;
    }

    const responseMode = parseResponseMode(data.responseMode);

    if (responseMode) {
      update.responseMode = responseMode;
    }

    const currentBinding = await DiscordAssistantBinding.findById(req.params.id);

    if (!currentBinding) {
      throw notFound("Binding not found");
    }

    const nextTenantId = String(update.tenantId ?? currentBinding.tenantId);
    const nextGuildId = String(
      update.discordGuildId ?? currentBinding.discordGuildId,
    );
    const nextChannelId = String(
      update.discordChannelId ?? currentBinding.discordChannelId,
    );

    await loadConnectedInstallation({
      tenantId: nextTenantId,
      discordGuildId: nextGuildId,
    });

    if (update.enabled !== false) {
      await assertChannelAvailable({
        discordGuildId: nextGuildId,
        discordChannelId: nextChannelId,
        bindingId: String(req.params.id),
      });
    }

    const binding = await DiscordAssistantBinding.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true, runValidators: true },
    );

    if (!binding) {
      throw notFound("Binding not found");
    }

    res.json({ binding });
  }),
);

adminBindingsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw badRequest("Invalid binding id");
    }

    const binding = await DiscordAssistantBinding.findByIdAndDelete(req.params.id);

    if (!binding) {
      throw notFound("Binding not found");
    }

    res.json({ ok: true });
  }),
);

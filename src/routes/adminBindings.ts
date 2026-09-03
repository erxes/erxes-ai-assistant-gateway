import { Router } from "express";
import mongoose from "mongoose";

import { env } from "../config/env.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import {
  DiscordAssistantBinding,
  discordAssistantResponseModes,
  type DiscordAssistantResponseMode,
} from "../models/DiscordAssistantBinding.js";
import { DiscordInstallation } from "../models/DiscordInstallation.js";
import {
  disableBindingsForRuntime,
  rehomeBindingsForRuntime,
  runtimeUrlVariants,
} from "../discord/bindingLifecycle.js";
import {
  assistantRuntimeKinds,
  type AssistantRuntimeKind,
} from "../runtime/identity.js";
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

const parseRuntimeKind = (
  value: unknown,
): AssistantRuntimeKind | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== "string" ||
    !assistantRuntimeKinds.includes(value as AssistantRuntimeKind)
  ) {
    throw badRequest("runtimeKind must be openclaw or hermes");
  }

  return value as AssistantRuntimeKind;
};

const validateRuntimeUrl = (value: string, runtimeKind: AssistantRuntimeKind) => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw badRequest("openclawUrl must be a valid absolute URL");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw badRequest(
      "openclawUrl must be an HTTP(S) URL without credentials, query, or fragment",
    );
  }

  const internalHttp =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname.endsWith(".svc") ||
    url.hostname.endsWith(".svc.cluster.local");

  if (
    runtimeKind === "hermes" &&
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && internalHttp)
  ) {
    throw badRequest("Hermes runtime URLs must use HTTPS outside the cluster");
  }

  return value.replace(/\/+$/, "");
};

const parseCreateBindingBody = (body: unknown) => {
  if (!body || typeof body !== "object") {
    throw badRequest("Request body must be an object");
  }

  const data = body as Record<string, unknown>;

  const runtimeKind = parseRuntimeKind(data.runtimeKind) ?? "openclaw";

  return {
    installationId: optionalString(data, "installationId"),
    tenantId: requiredString(data, "tenantId"),
    assistantId: requiredString(data, "assistantId"),
    assistantName: optionalString(data, "assistantName"),
    discordGuildId: requiredString(data, "discordGuildId"),
    discordChannelId: requiredString(data, "discordChannelId"),
    openclawUrl: validateRuntimeUrl(
      requiredString(data, "openclawUrl"),
      runtimeKind,
    ),
    runtimeKind,
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

    if (input.runtimeKind === "hermes" && !env.OPENCLAW_SHARED_SECRET) {
      throw badRequest(
        "OPENCLAW_SHARED_SECRET is required for Hermes runtime bindings",
      );
    }

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
          runtimeKind: input.runtimeKind,
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
      "runtimeKind",
      "discordGuildId",
      "discordChannelId",
    ]) {
      const value = req.query[field];

      if (typeof value === "string" && value.trim().length > 0) {
        query[field] = value.trim();
      }
    }

    // Lifecycle callers (transfer, delete) know only the runtime URL — the
    // tenant/assistant ids on the binding are exactly what went stale.
    const openclawUrl = req.query.openclawUrl;

    if (typeof openclawUrl === "string" && openclawUrl.trim().length > 0) {
      query.openclawUrl = { $in: runtimeUrlVariants(openclawUrl) };
    }

    const bindings = await DiscordAssistantBinding.find(query)
      .sort({ createdAt: -1 })
      .limit(200);

    res.json({ bindings });
  }),
);

// Assistant transfer: move every binding of a runtime to its new owner, and
// make sure the new tenant has a connected installation for each guild so the
// connection stays manageable from its UI. Chat routing never breaks either
// way (it follows the stored URL) — this fixes ownership.
adminBindingsRouter.post(
  "/rehome",
  asyncHandler(async (req, res) => {
    if (!req.body || typeof req.body !== "object") {
      throw badRequest("Request body must be an object");
    }

    const data = req.body as Record<string, unknown>;
    const result = await rehomeBindingsForRuntime(
      requiredString(data, "openclawUrl"),
      {
        tenantId: requiredString(data, "tenantId"),
        assistantId: requiredString(data, "assistantId"),
        assistantName: optionalString(data, "assistantName"),
      },
    );

    res.json(result);
  }),
);

// Runtime destroyed: disable its bindings so the channel unique-slot frees up
// and customer messages stop dead-ending into a deleted namespace.
adminBindingsRouter.post(
  "/disable-by-url",
  asyncHandler(async (req, res) => {
    if (!req.body || typeof req.body !== "object") {
      throw badRequest("Request body must be an object");
    }

    const data = req.body as Record<string, unknown>;
    const result = await disableBindingsForRuntime(
      requiredString(data, "openclawUrl"),
    );

    res.json(result);
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
    const runtimeKind = parseRuntimeKind(data.runtimeKind);

    if (responseMode) {
      update.responseMode = responseMode;
    }

    if (runtimeKind) {
      update.runtimeKind = runtimeKind;
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
    const nextRuntimeKind = (update.runtimeKind ??
      currentBinding.runtimeKind ??
      "openclaw") as AssistantRuntimeKind;

    if (nextRuntimeKind === "hermes" && !env.OPENCLAW_SHARED_SECRET) {
      throw badRequest(
        "OPENCLAW_SHARED_SECRET is required for Hermes runtime bindings",
      );
    }

    if (update.openclawUrl !== undefined || runtimeKind) {
      update.openclawUrl = validateRuntimeUrl(
        String(update.openclawUrl ?? currentBinding.openclawUrl),
        nextRuntimeKind,
      );
    }

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

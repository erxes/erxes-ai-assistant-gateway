import type { Client } from "discord.js";

import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { AssistantJob } from "../models/AssistantJob.js";
import {
  downloadRuntimeGeneratedFile,
  getOpenClawAssistantJob,
  startOpenClawAssistantJob,
  type RuntimeGeneratedFile,
} from "../openclaw/client.js";
import { mongoAssistantJobStore } from "./assistantJobStore.js";
import {
  buildJobIdempotencyKey,
  runDiscordAssistantJob,
} from "./jobRunner.js";
import { summarizeOperation } from "./longOps.js";
import {
  buildRuntimeFilePayloads,
  type DiscordFilePayload,
  type LongOperationJobRequest,
} from "./messageGateway.js";
import { SECRET_REFUSAL_MESSAGE } from "../security/secretGuard.js";
import type { RuntimeIdentity } from "../runtime/identity.js";

const buildDeliverFiles = (
  openclawUrl: string,
  identity: RuntimeIdentity,
  sendFiles?: (caption: string, files: DiscordFilePayload[]) => Promise<unknown>,
) => {
  if (!sendFiles) {
    return undefined;
  }

  return async (files: RuntimeGeneratedFile[]) => {
    const { payloads, failed, blocked } = await buildRuntimeFilePayloads(
      openclawUrl,
      files,
      (url, fileId) => downloadRuntimeGeneratedFile(url, fileId, identity),
    );

    if (payloads.length > 0) {
      await sendFiles("Here is the generated file.", payloads);
    }

    if (blocked.length > 0) {
      await sendFiles(SECRET_REFUSAL_MESSAGE, []).catch(() => undefined);
    }

    if (failed.length > 0 || (payloads.length === 0 && blocked.length === 0)) {
      throw new Error("Some generated files could not be uploaded");
    }
  };
};

const jobSettings = () => ({
  pollIntervalMs: env.ASSISTANT_JOB_POLL_INTERVAL_MS,
  timeoutMs: env.ASSISTANT_JOB_TIMEOUT_MS,
});

export const launchDiscordLongOperationJob = async (
  request: LongOperationJobRequest,
) => {
  const idempotencyKey = buildJobIdempotencyKey({
    assistantId: request.ask.assistantId,
    opType: request.opType,
    messageId: request.messageId,
  });

  return runDiscordAssistantJob({
    record: {
      tenantId: request.ask.tenantId,
      assistantId: request.ask.assistantId,
      runtimeKind: request.ask.runtimeKind || "openclaw",
      openclawUrl: request.ask.openclawUrl,
      guildId: request.guildId,
      channelId: request.channelId,
      threadId: request.threadId,
      messageId: request.messageId,
      conversationKey: request.conversationId,
      opType: request.opType,
      operation: summarizeOperation(request.ask.question),
      idempotencyKey,
    },
    ask: request.ask,
    store: mongoAssistantJobStore,
    ack: request.ack,
    notify: request.notify,
    startJob: startOpenClawAssistantJob,
    getJob: getOpenClawAssistantJob,
    logger,
    skipAck: request.skipAck,
    ackMode: request.ackMode,
    ackDelayMs: request.ackDelayMs ?? env.ASSISTANT_NORMAL_CHAT_ACK_DELAY_MS,
    quiet: request.quiet,
    deliverFiles: buildDeliverFiles(
      request.ask.openclawUrl,
      request.ask,
      request.sendFiles,
    ),
    ...jobSettings(),
    ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
  });
};

const RESUME_WINDOW_MS = 20 * 60 * 1000;

export const resumeStaleAssistantJobs = async (client: Client) => {
  const staleJobs = await AssistantJob.find({
    status: { $in: ["started", "running", "verifying"] },
    runtimeJobId: { $exists: true, $nin: [null, ""] },
    updatedAt: { $gte: new Date(Date.now() - RESUME_WINDOW_MS) },
  }).lean();

  for (const job of staleJobs) {
    const targetChannelId = job.threadId || job.channelId;

    let notify: (content: string) => Promise<unknown>;
    let sendFiles:
      | ((caption: string, files: DiscordFilePayload[]) => Promise<unknown>)
      | undefined;

    try {
      const channel = await client.channels.fetch(targetChannelId);

      if (!channel || !("send" in channel) || typeof channel.send !== "function") {
        throw new Error("Channel is not sendable");
      }

      notify = (content: string) =>
        (channel as { send: (payload: unknown) => Promise<unknown> }).send({
          content,
          allowedMentions: { repliedUser: false },
        });
      sendFiles = (caption: string, files: DiscordFilePayload[]) =>
        (channel as { send: (payload: unknown) => Promise<unknown> }).send({
          content: caption,
          allowedMentions: { repliedUser: false },
          files,
        });
    } catch (error) {
      logger.error("Could not resume assistant job notifications", {
        idempotencyKey: job.idempotencyKey,
        guildId: job.guildId,
        channelId: job.channelId,
        threadId: job.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      await AssistantJob.updateOne(
        { idempotencyKey: job.idempotencyKey },
        { $set: { status: "failed", error: "Gateway restarted; channel unavailable" } },
      ).catch(() => undefined);
      continue;
    }

    logger.info("Resuming assistant job polling after restart", {
      idempotencyKey: job.idempotencyKey,
      guildId: job.guildId,
      channelId: job.channelId,
      threadId: job.threadId,
      opType: job.opType,
    });

    void runDiscordAssistantJob({
      record: {
        tenantId: job.tenantId,
        assistantId: job.assistantId,
        runtimeKind: job.runtimeKind || "openclaw",
        openclawUrl: job.openclawUrl,
        guildId: job.guildId,
        channelId: job.channelId,
        threadId: job.threadId ?? undefined,
        messageId: job.messageId,
        conversationKey: job.conversationKey,
        opType: job.opType,
        operation: job.operation ?? "",
        idempotencyKey: job.idempotencyKey,
      },
      ask: {
        openclawUrl: job.openclawUrl,
        tenantId: job.tenantId,
        assistantId: job.assistantId,
        runtimeKind: job.runtimeKind || "openclaw",
        question: "",
        user: { id: "system", username: "system" },
        discord: { guildId: job.guildId, channelId: job.channelId },
      },
      store: mongoAssistantJobStore,
      ack: async () => undefined,
      notify,
      startJob: startOpenClawAssistantJob,
      getJob: getOpenClawAssistantJob,
      logger,
      runtimeJobId: job.runtimeJobId as string,
      deliverFiles: buildDeliverFiles(
        job.openclawUrl,
        {
          tenantId: job.tenantId,
          assistantId: job.assistantId,
          runtimeKind: job.runtimeKind || "openclaw",
        },
        sendFiles,
      ),
      ...jobSettings(),
    }).catch((error) => {
      logger.error("Resumed assistant job failed", {
        idempotencyKey: job.idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return staleJobs.length;
};

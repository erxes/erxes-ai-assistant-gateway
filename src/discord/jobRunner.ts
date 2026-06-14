import type { logger } from "../lib/logger.js";
import type {
  AssistantRuntimeJob,
  askOpenClawAssistant,
  getOpenClawAssistantJob,
  RuntimeGeneratedFile,
  startOpenClawAssistantJob,
} from "../openclaw/client.js";
import { splitDiscordMessage } from "./messageGateway.js";
import { guardOutboundText } from "../security/secretGuard.js";
import {
  buildReferenceId,
  categorizeError,
  friendlyRuntimeErrorMessage,
} from "../openclaw/errors.js";

type AskInput = Parameters<typeof askOpenClawAssistant>[0];

export type AssistantJobRecord = {
  tenantId: string;
  assistantId: string;
  openclawUrl: string;
  guildId: string;
  channelId: string;
  threadId?: string;
  messageId: string;
  conversationKey: string;
  opType: string;
  operation: string;
  idempotencyKey: string;
};

export type AssistantJobStore = {
  create: (record: AssistantJobRecord) => Promise<{ created: boolean; id?: string }>;
  update: (
    idempotencyKey: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
};

export type RunDiscordAssistantJobParams = {
  record: AssistantJobRecord;
  ask: AskInput & { openclawUrl: string };
  store: AssistantJobStore;
  ack: (content: string) => Promise<unknown>;
  notify: (content: string) => Promise<unknown>;
  startJob: typeof startOpenClawAssistantJob;
  getJob: typeof getOpenClawAssistantJob;
  logger: Pick<typeof logger, "info" | "error">;
  pollIntervalMs: number;
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  runtimeJobId?: string;
  skipAck?: boolean;
  /**
   * "immediate" (default) acks with "Started…" before polling — used for
   * known long operations. "delayed" stays silent and only acks with
   * "Still working…" if the job is not done after ackDelayMs — used for
   * normal chat so quick answers arrive without ceremony.
   */
  ackMode?: "immediate" | "delayed";
  ackDelayMs?: number;
  /** Suppress intermediate stage messages (normal chat). */
  quiet?: boolean;
  deliverFiles?: (files: RuntimeGeneratedFile[]) => Promise<void>;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const IMMEDIATE_ACK_MESSAGE = "Started. I'll post progress here.";
export const DELAYED_ACK_MESSAGE =
  "Still working — I'll post the answer here when it's ready.";

const safeRuntimeHost = (openclawUrl: string): string | undefined => {
  try {
    return new URL(openclawUrl).hostname;
  } catch {
    return undefined;
  }
};

const STAGE_MESSAGES: Record<string, string> = {
  verifying: "Verifying the result…",
};

/**
 * Turn a failed runtime job into a useful Discord message. Prefers the
 * runtime's own safeMessage, then its error category, and only then a raw
 * error summary — never a generic "could not respond".
 */
export const describeJobFailure = (status: {
  error?: string;
  category?: string;
  safeMessage?: string;
}): string => {
  if (status.safeMessage) return status.safeMessage;

  const error = status.error || "";

  if (/adapter restarted while the job was running/i.test(error)) {
    return "The runtime restarted before this job completed. Please retry.";
  }

  switch (status.category) {
    case "runtime_unreachable":
      return "The assistant runtime is currently unreachable. I could not complete the operation. Please retry shortly.";
    case "provider_timeout":
      return "The model provider timed out while processing this request. Please retry; no changes were applied.";
    case "runtime_timeout":
      return "The operation timed out on the runtime. It may still need cleanup; please retry.";
    case "plugin_quarantined":
    case "plugin_validation_failed":
      return "A plugin involved in this operation is installed but could not be loaded, so it was kept unloaded. The assistant and other features keep working; it can be retried any time.";
    default:
      return `The operation failed: ${error || "unknown error"}`;
  }
};

const safeJobLogFields = (record: AssistantJobRecord) => ({
  opType: record.opType,
  assistantId: record.assistantId,
  tenantId: record.tenantId,
  guildId: record.guildId,
  channelId: record.channelId,
  threadId: record.threadId,
  conversationKey: record.conversationKey,
  messageId: record.messageId,
});

export const buildJobIdempotencyKey = (input: {
  assistantId: string;
  opType: string;
  messageId: string;
}) => `${input.assistantId}:${input.opType}:${input.messageId}`;

export const runDiscordAssistantJob = async (
  params: RunDiscordAssistantJobParams,
): Promise<"duplicate" | "ready" | "failed" | "timeout"> => {
  const {
    record,
    ask,
    store,
    ack,
    notify,
    startJob,
    getJob,
    pollIntervalMs,
    timeoutMs,
  } = params;
  const sleep = params.sleep ?? defaultSleep;
  const startedAt = Date.now();
  const ackMode = params.ackMode ?? "immediate";
  let acked = false;

  if (!params.runtimeJobId) {
    const creation = await store.create(record);

    if (!creation.created) {
      params.logger.info("Discord assistant job duplicate ignored", {
        ...safeJobLogFields(record),
      });
      return "duplicate";
    }

    if (!params.skipAck && ackMode === "immediate") {
      await ack(IMMEDIATE_ACK_MESSAGE).catch(() => undefined);
      acked = true;
    }
  }

  const ackDeadline = startedAt + (params.ackDelayMs ?? 10_000);
  const sendDelayedAckIfDue = async () => {
    if (acked || params.skipAck || ackMode !== "delayed") return;
    if (Date.now() < ackDeadline) return;
    acked = true;
    await ack(DELAYED_ACK_MESSAGE).catch(() => undefined);
  };

  const finish = async (
    outcome: "ready" | "failed" | "timeout",
    patch: Record<string, unknown>,
    message?: string,
  ) => {
    await store
      .update(record.idempotencyKey, patch)
      .catch(() => undefined);

    if (message) {
      for (const chunk of splitDiscordMessage(message)) {
        await notify(chunk).catch(() => undefined);
      }
    }

    params.logger.info("Discord assistant job finished", {
      ...safeJobLogFields(record),
      runtimeHost: safeRuntimeHost(record.openclawUrl),
      outcome,
      durationMs: Date.now() - startedAt,
    });

    return outcome;
  };

  try {
    let runtimeJobId = params.runtimeJobId;

    if (!runtimeJobId) {
      const remote = await startJob({
        ...ask,
        jobKey: record.idempotencyKey,
      });
      runtimeJobId = remote.id;
      await store.update(record.idempotencyKey, {
        runtimeJobId,
        status: "running",
      });
    }

    let lastStage = "running";
    const deadline = startedAt + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      await sendDelayedAckIfDue();

      let status: AssistantRuntimeJob | null = null;

      try {
        status = await getJob(record.openclawUrl, runtimeJobId);
      } catch {
        continue;
      }

      if (status.status === "ready") {
        // Layer 3: guard the async final answer text before sending.
        const guardedAnswer = guardOutboundText(
          status.answer || "The operation finished, but no result text was returned.",
        ).text;
        const outcome = await finish("ready", { status: "ready" }, guardedAnswer);

        if (status.files?.length && params.deliverFiles) {
          await params.deliverFiles(status.files).catch(async () => {
            await notify(
              "I created the file, but couldn't upload it to Discord.",
            ).catch(() => undefined);
          });
        }

        if (status.fileErrors?.length) {
          await notify(
            `Note: some generated files couldn't be prepared: ${status.fileErrors.join("; ")}`,
          ).catch(() => undefined);
        }

        return outcome;
      }

      if (status.status === "failed") {
        return await finish(
          "failed",
          {
            status: "failed",
            error: status.error || "Job failed",
            errorCategory: status.category,
          },
          describeJobFailure(status),
        );
      }

      if (status.stage && status.stage !== lastStage) {
        lastStage = status.stage;
        await store
          .update(record.idempotencyKey, { status: status.status })
          .catch(() => undefined);

        const stageMessage = params.quiet ? undefined : STAGE_MESSAGES[status.stage];

        if (stageMessage) {
          await notify(stageMessage).catch(() => undefined);
        }
      }
    }

    return await finish(
      "timeout",
      { status: "failed", error: "Job timed out" },
      `The operation timed out after ${Math.round(timeoutMs / 60000)} minutes. It may still finish on the runtime; ask me to check again later.`,
    );
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : "unknown error";
    const referenceId = buildReferenceId(record.messageId);

    params.logger.error("Discord assistant job errored", {
      ...safeJobLogFields(record),
      referenceId,
      errorCategory: categorizeError(error),
      error: messageText,
    });

    return await finish(
      "failed",
      { status: "failed", error: messageText, errorCategory: categorizeError(error) },
      friendlyRuntimeErrorMessage(error, referenceId),
    );
  }
};

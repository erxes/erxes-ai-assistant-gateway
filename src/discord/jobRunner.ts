import type { logger } from "../lib/logger.js";
import type {
  AssistantRuntimeJob,
  askOpenClawAssistant,
  getOpenClawAssistantJob,
  RuntimeGeneratedFile,
  startOpenClawAssistantJob,
} from "../openclaw/client.js";
import { splitDiscordMessage } from "./messageGateway.js";

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
  deliverFiles?: (files: RuntimeGeneratedFile[]) => Promise<void>;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const STAGE_MESSAGES: Record<string, string> = {
  verifying: "Verifying the result…",
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

  if (!params.runtimeJobId) {
    const creation = await store.create(record);

    if (!creation.created) {
      params.logger.info("Discord assistant job duplicate ignored", {
        ...safeJobLogFields(record),
      });
      return "duplicate";
    }

    if (!params.skipAck) {
      await ack("Started. I'll post progress here.").catch(() => undefined);
    }
  }

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

      let status: AssistantRuntimeJob | null = null;

      try {
        status = await getJob(record.openclawUrl, runtimeJobId);
      } catch {
        continue;
      }

      if (status.status === "ready") {
        const outcome = await finish(
          "ready",
          { status: "ready" },
          status.answer || "The operation finished, but no result text was returned.",
        );

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
          { status: "failed", error: status.error || "Job failed" },
          `The operation failed: ${status.error || "unknown error"}`,
        );
      }

      if (status.stage && status.stage !== lastStage) {
        lastStage = status.stage;
        await store
          .update(record.idempotencyKey, { status: status.status })
          .catch(() => undefined);

        const stageMessage = STAGE_MESSAGES[status.stage];

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

    params.logger.error("Discord assistant job errored", {
      ...safeJobLogFields(record),
      error: messageText,
    });

    return await finish(
      "failed",
      { status: "failed", error: messageText },
      "The operation could not be started or tracked. Please try again.",
    );
  }
};

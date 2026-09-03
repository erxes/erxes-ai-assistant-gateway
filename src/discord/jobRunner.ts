import type { logger } from "../lib/logger.js";
import type {
  AssistantRuntimeJob,
  askOpenClawAssistant,
  getOpenClawAssistantJob,
  RuntimeGeneratedFile,
  startOpenClawAssistantJob,
} from "../openclaw/client.js";
import type { AssistantRuntimeKind } from "../runtime/identity.js";
import { splitDiscordMessage } from "./messageGateway.js";
import { guardOutboundText } from "../security/secretGuard.js";
import {
  applyChannelCreateMarkers,
  applyChannelPostMarkers,
  type ChannelBindingContext,
} from "./channelActions.js";
import {
  buildReferenceId,
  categorizeError,
  friendlyRuntimeErrorMessage,
  OpenClawRuntimeError,
} from "../openclaw/errors.js";

type AskInput = Parameters<typeof askOpenClawAssistant>[0];

export type AssistantJobRecord = {
  tenantId: string;
  assistantId: string;
  runtimeKind?: AssistantRuntimeKind;
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

// Give up polling once the runtime is persistently unreachable instead of
// silently looping until the full job timeout. A 404 means the job file is
// gone (e.g. the adapter's job store was wiped), so fail faster on that.
const MAX_CONSECUTIVE_POLL_ERRORS = 12;
const MAX_CONSECUTIVE_JOB_NOT_FOUND = 3;

// Unreachability is budgeted by TIME, not attempts: pod restarts take 60-120s
// and 12 polls at 5s gave up at ~60s. The grace window rides out any restart;
// the downtime is credited back to the job deadline when the runtime returns.
const UNREACHABLE_GRACE_MS = 240_000;
const RESTART_NOTICE_AFTER_MS = 20_000;
const MAX_JOB_RESUBMISSIONS = 2;

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
    // Deliver the answer/message BEFORE persisting the terminal status, so a
    // failed Discord send is never recorded as a delivered "ready" job and is
    // never silently swallowed.
    let delivered = true;

    if (message) {
      for (const chunk of splitDiscordMessage(message)) {
        try {
          await notify(chunk);
        } catch (deliveryError) {
          delivered = false;
          params.logger.error("Discord assistant job delivery failed", {
            ...safeJobLogFields(record),
            runtimeHost: safeRuntimeHost(record.openclawUrl),
            outcome,
            error:
              deliveryError instanceof Error
                ? deliveryError.message
                : String(deliveryError),
          });
          break;
        }
      }
    }

    // If a "ready" answer could not be delivered, leave the job in a status
    // that resumeStaleAssistantJobs re-picks so it can be redelivered later
    // rather than marking it done with the answer lost.
    const persistPatch =
      delivered || outcome !== "ready" ? patch : { status: "running" };

    await store
      .update(record.idempotencyKey, persistPatch)
      .catch(() => undefined);

    params.logger.info("Discord assistant job finished", {
      ...safeJobLogFields(record),
      runtimeHost: safeRuntimeHost(record.openclawUrl),
      outcome,
      delivered,
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
    let consecutivePollErrors = 0;
    let deadline = startedAt + timeoutMs;
    // A deployer-initiated pod restart takes 60-120s. Count unreachability by
    // TIME, not poll attempts — 12 polls at 5s gave up at ~60s, just short of
    // every restart (live incident 2026-08-25). The downtime is credited back
    // to the job deadline so waiting out a restart never causes a timeout.
    let unreachableSince: number | null = null;
    let restartNoticeSent = false;
    let resubmissions = 0;

    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      await sendDelayedAckIfDue();

      let status: AssistantRuntimeJob | null = null;

      try {
        status = await getJob(record.openclawUrl, runtimeJobId, {
          tenantId: record.tenantId,
          assistantId: record.assistantId,
          runtimeKind: record.runtimeKind || "openclaw",
        });
        consecutivePollErrors = 0;
        if (unreachableSince !== null) {
          deadline += Date.now() - unreachableSince;
          unreachableSince = null;
        }
      } catch (pollError) {
        consecutivePollErrors += 1;
        const errorCategory = categorizeError(pollError);
        const httpStatus =
          pollError instanceof OpenClawRuntimeError
            ? pollError.status
            : undefined;
        const errorMessage =
          pollError instanceof Error ? pollError.message : String(pollError);

        // Previously every poll error was swallowed (`catch { continue }`), so a
        // broken/wiped /jobs/:id was indistinguishable from "still working"
        // until the timeout. Log each failure and give up once it is terminal.
        params.logger.error("Discord assistant job poll failed", {
          ...safeJobLogFields(record),
          runtimeHost: safeRuntimeHost(record.openclawUrl),
          runtimeJobId,
          errorCategory,
          httpStatus,
          consecutivePollErrors,
          error: errorMessage,
        });

        const jobGone =
          httpStatus === 404 &&
          consecutivePollErrors >= MAX_CONSECUTIVE_JOB_NOT_FOUND;

        // The adapter keeps job state in emptyDir, so a pod restart 404s every
        // in-flight job. The runtime lost the work — resubmit it under the same
        // idempotency key instead of failing the customer's message.
        if (jobGone && resubmissions < MAX_JOB_RESUBMISSIONS) {
          try {
            const remote = await startJob({
              ...ask,
              jobKey: record.idempotencyKey,
            });
            resubmissions += 1;
            runtimeJobId = remote.id;
            consecutivePollErrors = 0;
            unreachableSince = null;
            await store
              .update(record.idempotencyKey, { runtimeJobId, status: "running" })
              .catch(() => undefined);
            params.logger.info("Discord assistant job resubmitted after runtime lost it", {
              ...safeJobLogFields(record),
              runtimeHost: safeRuntimeHost(record.openclawUrl),
              runtimeJobId,
              resubmissions,
            });
            continue;
          } catch (resubmitError) {
            params.logger.error("Discord assistant job resubmission failed", {
              ...safeJobLogFields(record),
              runtimeHost: safeRuntimeHost(record.openclawUrl),
              error:
                resubmitError instanceof Error
                  ? resubmitError.message
                  : String(resubmitError),
            });
          }
        }

        const unreachable =
          errorCategory === "runtime_unreachable" && httpStatus !== 404;

        if (unreachable) {
          if (unreachableSince === null) unreachableSince = Date.now();
          const downMs = Date.now() - unreachableSince;

          if (downMs >= RESTART_NOTICE_AFTER_MS && !restartNoticeSent) {
            restartNoticeSent = true;
            await notify(
              "The assistant is busy or restarting — retrying automatically, hang on.",
            ).catch(() => undefined);
          }

          if (downMs < UNREACHABLE_GRACE_MS) {
            continue;
          }
        }

        if (
          jobGone ||
          unreachable ||
          consecutivePollErrors >= MAX_CONSECUTIVE_POLL_ERRORS
        ) {
          const referenceId = buildReferenceId(record.messageId);
          return await finish(
            "failed",
            { status: "failed", error: errorMessage, errorCategory },
            friendlyRuntimeErrorMessage(pollError, referenceId),
          );
        }

        continue;
      }

      if (status.status === "ready") {
        // Layer 3: guard the async final answer text before sending.
        const guardedAnswer = guardOutboundText(
          status.answer || "The operation finished, but no result text was returned.",
        ).text;
        const log = (message: string, meta?: Record<string, unknown>) =>
          params.logger.info(message, { ...safeJobLogFields(record), ...meta });
        // [discord-create-channel: name] — create channels in the originating guild.
        const channelBindingCtx: ChannelBindingContext = {
          tenantId: record.tenantId,
          assistantId: record.assistantId,
          openclawUrl: record.openclawUrl,
          runtimeKind: record.runtimeKind || "openclaw",
        };
        const created = await applyChannelCreateMarkers(
          guardedAnswer,
          record.guildId,
          log,
          channelBindingCtx,
        );
        // [discord-post-channel: target] … [/discord-post-channel] — post content
        // into a specific channel in this assistant's own guild (run AFTER create
        // so a channel made this turn is resolvable by name).
        const posted = await applyChannelPostMarkers(
          created.text,
          record.assistantId,
          log,
          channelBindingCtx,
        );
        const finalAnswer =
          [posted.text, created.note, posted.note]
            .filter((part) => part && part.trim())
            .join("\n\n") || "Done.";
        const outcome = await finish("ready", { status: "ready" }, finalAnswer);

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

import { env } from "../config/env.js";
import {
  buildRuntimeIdentityHeaders,
  type AssistantRuntimeKind,
  type RuntimeIdentity,
} from "../runtime/identity.js";
import {
  OpenClawRuntimeError,
  runtimeErrorFromNetworkFailure,
  runtimeErrorFromResponse,
} from "./errors.js";

export type AskAssistantInput = {
  openclawUrl: string;
  tenantId: string;
  assistantId: string;
  runtimeKind?: AssistantRuntimeKind;
  question: string;
  user: {
    id: string;
    username: string;
  };
  discord: {
    guildId: string;
    channelId: string;
    guildName?: string;
    channelName?: string;
    threadId?: string;
    threadName?: string;
    messageId?: string;
    userId?: string;
    username?: string;
    authorDisplayName?: string;
    responseMode?: string;
    conversationId?: string;
    attachments?: Array<{
      kind: "image" | "file";
      filename: string;
      contentType: string;
      size: number;
      url: string;
    }>;
  };
};

type FlexibleOpenClawResponse = {
  answer?: unknown;
  message?: unknown;
  content?: unknown;
  response?: unknown;
  error?: unknown;
};

const normalizeOpenClawUrl = (openclawUrl: string) =>
  openclawUrl.replace(/\/+$/, "");

// Retry schedule for transient runtime failures. The old policy (3 attempts,
// 800ms base, unreachable-only) gave up in 2.4s — far short of the 60–120s a
// deployer-initiated pod restart takes — and never retried 429/500 at all,
// which a 7-day failure census showed were the top two customer-visible
// failure causes. Total patience here ≈ 3.5 minutes.
export const RUNTIME_RETRY_SCHEDULE_MS = [
  5_000, 15_000, 30_000, 60_000, 90_000,
];

const runtimeSecretHeaders = (): Record<string, string> =>
  env.OPENCLAW_SHARED_SECRET
    ? { "x-erxes-ai-assistant-secret": env.OPENCLAW_SHARED_SECRET }
    : {};

const runtimeRequestHeaders = (
  identity: RuntimeIdentity | undefined,
  method: string,
  path: string,
) => ({
  ...runtimeSecretHeaders(),
  ...(identity
    ? buildRuntimeIdentityHeaders({
        identity,
        method,
        path,
        sharedSecret: env.OPENCLAW_SHARED_SECRET,
      })
    : {}),
});

// 429 is the runtime's own busy signal (gateway concurrency), not a provider
// rate limit — spaced backoff is the correct response. 500 gets at most two
// retries: it can follow a mid-turn pod death (recoverable) but may also mean
// the turn partially executed, so we cap duplicate side-effect exposure.
// Timeouts are never retried — re-running long work compounds the problem.
export const shouldRetryRuntimeError = (
  error: unknown,
  attempt: number,
): boolean => {
  if (!(error instanceof OpenClawRuntimeError)) return false;
  if (error.category === "runtime_unreachable") return true;
  if (error.status === 429) return true;
  if (error.status === 500 && attempt < 2) return true;
  return false;
};

export type RuntimeRetryInfo = {
  attempt: number;
  delayMs: number;
  error: unknown;
};

export type RuntimeRetryOptions = {
  onRetry?: (info: RuntimeRetryInfo) => void;
  sleep?: (ms: number) => Promise<void>;
};

export const withRuntimeRetry = async <T>(
  fn: () => Promise<T>,
  options: RuntimeRetryOptions = {},
): Promise<T> => {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const delayMs = RUNTIME_RETRY_SCHEDULE_MS[attempt];

      if (delayMs === undefined || !shouldRetryRuntimeError(error, attempt)) {
        throw error;
      }

      try {
        options.onRetry?.({ attempt: attempt + 1, delayMs, error });
      } catch {
        // A broken notify hook must never break the retry loop itself.
      }
      await sleep(delayMs);
    }
  }
};

export type RuntimeGeneratedFile = {
  fileId: string;
  filename: string;
  contentType: string;
  size: number;
};

export type AssistantAskResult = {
  answer: string;
  files: RuntimeGeneratedFile[];
  fileErrors: string[];
};

const parseAssistantAnswer = (body: FlexibleOpenClawResponse) => {
  const value = body.answer ?? body.message ?? body.content ?? body.response;

  if (typeof value === "string" && value.trim().length > 0) {
    const answer = value.trim();

    return answer;
  }

  return "The assistant returned an empty response.";
};

export const parseRuntimeGeneratedFiles = (
  value: unknown,
): RuntimeGeneratedFile[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item): item is RuntimeGeneratedFile =>
        Boolean(item) &&
        typeof (item as RuntimeGeneratedFile).fileId === "string" &&
        /^[a-f0-9-]{36}$/.test((item as RuntimeGeneratedFile).fileId) &&
        typeof (item as RuntimeGeneratedFile).filename === "string" &&
        typeof (item as RuntimeGeneratedFile).contentType === "string" &&
        Number.isFinite((item as RuntimeGeneratedFile).size),
    )
    .slice(0, 5);
};

const parseFileErrors = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, 5)
    : [];

const askOpenClawAssistantOnce = async (
  input: AskAssistantInput,
): Promise<AssistantAskResult> => {
  let response: Response;
  const path = "/api/erxes-ai-assistant/ask";

  try {
    response = await fetch(
      `${normalizeOpenClawUrl(input.openclawUrl)}${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...runtimeRequestHeaders(input, "POST", path),
        },
        body: JSON.stringify({
          tenantId: input.tenantId,
          assistantId: input.assistantId,
          runtimeKind: input.runtimeKind || "openclaw",
          question: input.question,
          user: input.user,
          discord: input.discord,
          source: "discord",
        }),
        signal: AbortSignal.timeout(env.OPENCLAW_REQUEST_TIMEOUT_MS),
      },
    );
  } catch (error) {
    throw runtimeErrorFromNetworkFailure(error);
  }

  const text = await response.text();

  if (!response.ok) {
    throw runtimeErrorFromResponse(response.status, text);
  }

  let body: FlexibleOpenClawResponse & { files?: unknown; fileErrors?: unknown } =
    {};

  if (text.length > 0) {
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error("OpenClaw returned invalid JSON");
    }
  }

  return {
    answer: parseAssistantAnswer(body),
    files: parseRuntimeGeneratedFiles(body.files),
    fileErrors: parseFileErrors(body.fileErrors),
  };
};

export const askOpenClawAssistant = (
  input: AskAssistantInput,
  retryOptions?: RuntimeRetryOptions,
): Promise<AssistantAskResult> =>
  withRuntimeRetry(() => askOpenClawAssistantOnce(input), retryOptions);

const MAX_RUNTIME_FILE_DOWNLOAD_BYTES = 9 * 1024 * 1024;

export const downloadRuntimeGeneratedFile = async (
  openclawUrl: string,
  fileId: string,
  identity?: RuntimeIdentity,
): Promise<Buffer> => {
  if (!/^[a-f0-9-]{36}$/.test(fileId)) {
    throw new Error("Invalid runtime file id");
  }

  const path = `/api/erxes-ai-assistant/internal/files/${fileId}`;
  const response = await fetch(
    `${normalizeOpenClawUrl(openclawUrl)}${path}`,
    {
      headers: runtimeRequestHeaders(identity, "GET", path),
      signal: AbortSignal.timeout(60_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Runtime file download failed with status ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  if (bytes.length === 0 || bytes.length > MAX_RUNTIME_FILE_DOWNLOAD_BYTES) {
    throw new Error("Runtime file download size is not allowed");
  }

  return bytes;
};

export type AssistantRuntimeJob = {
  id: string;
  jobKey?: string;
  status: "running" | "verifying" | "ready" | "failed";
  stage?: string;
  answer?: string;
  files?: RuntimeGeneratedFile[];
  fileErrors?: string[];
  error?: string;
  category?: string;
  safeMessage?: string;
  duplicate?: boolean;
};

const startOpenClawAssistantJobOnce = async (
  input: AskAssistantInput & { jobKey: string },
): Promise<AssistantRuntimeJob> => {
  let response: Response;
  const path = "/api/erxes-ai-assistant/ask-async";

  try {
    response = await fetch(
      `${normalizeOpenClawUrl(input.openclawUrl)}${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...runtimeRequestHeaders(input, "POST", path),
        },
        body: JSON.stringify({
          tenantId: input.tenantId,
          assistantId: input.assistantId,
          runtimeKind: input.runtimeKind || "openclaw",
          question: input.question,
          user: input.user,
          discord: input.discord,
          source: "discord",
          jobKey: input.jobKey,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (error) {
    throw runtimeErrorFromNetworkFailure(error);
  }

  const text = await response.text();

  if (!response.ok) {
    throw runtimeErrorFromResponse(response.status, text);
  }

  return JSON.parse(text) as AssistantRuntimeJob;
};

export const startOpenClawAssistantJob = (
  input: AskAssistantInput & { jobKey: string },
  retryOptions?: RuntimeRetryOptions,
): Promise<AssistantRuntimeJob> =>
  withRuntimeRetry(() => startOpenClawAssistantJobOnce(input), retryOptions);

export const getOpenClawAssistantJob = async (
  openclawUrl: string,
  jobId: string,
  identity?: RuntimeIdentity,
): Promise<AssistantRuntimeJob> => {
  let response: Response;
  const path = `/api/erxes-ai-assistant/jobs/${encodeURIComponent(jobId)}`;

  try {
    response = await fetch(
      `${normalizeOpenClawUrl(openclawUrl)}${path}`,
      {
        headers: runtimeRequestHeaders(identity, "GET", path),
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch (error) {
    throw runtimeErrorFromNetworkFailure(error);
  }

  const text = await response.text();

  if (!response.ok) {
    throw runtimeErrorFromResponse(response.status, text);
  }

  return JSON.parse(text) as AssistantRuntimeJob;
};

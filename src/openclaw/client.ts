import { env } from "../config/env.js";

type AskAssistantInput = {
  openclawUrl: string;
  tenantId: string;
  assistantId: string;
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

const sanitizeRemoteMessage = (text: string) => {
  if (!text.trim()) {
    return "empty response body";
  }

  try {
    const body = JSON.parse(text) as FlexibleOpenClawResponse;
    const value = body.error ?? body.message;

    if (typeof value === "string" && value.trim()) {
      return value.trim().replace(/\s+/g, " ").slice(0, 160);
    }
  } catch {
    // Fall back to the generic summary below for non-JSON bodies.
  }

  return `response body length ${text.length}`;
};

export const askOpenClawAssistant = async (
  input: AskAssistantInput,
): Promise<AssistantAskResult> => {
  const response = await fetch(
    `${normalizeOpenClawUrl(input.openclawUrl)}/api/erxes-ai-assistant/ask`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.OPENCLAW_SHARED_SECRET
          ? {
              "x-erxes-ai-assistant-secret": env.OPENCLAW_SHARED_SECRET,
            }
          : {}),
      },
      body: JSON.stringify({
        tenantId: input.tenantId,
        assistantId: input.assistantId,
        question: input.question,
        user: input.user,
        discord: input.discord,
        source: "discord",
      }),
      signal: AbortSignal.timeout(env.OPENCLAW_REQUEST_TIMEOUT_MS),
    },
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `OpenClaw request failed with status ${response.status}: ${sanitizeRemoteMessage(text)}`,
    );
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

const MAX_RUNTIME_FILE_DOWNLOAD_BYTES = 9 * 1024 * 1024;

export const downloadRuntimeGeneratedFile = async (
  openclawUrl: string,
  fileId: string,
): Promise<Buffer> => {
  if (!/^[a-f0-9-]{36}$/.test(fileId)) {
    throw new Error("Invalid runtime file id");
  }

  const response = await fetch(
    `${normalizeOpenClawUrl(openclawUrl)}/api/erxes-ai-assistant/internal/files/${fileId}`,
    {
      headers: { ...runtimeSecretHeaders() },
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
  duplicate?: boolean;
};

const runtimeSecretHeaders = (): Record<string, string> =>
  env.OPENCLAW_SHARED_SECRET
    ? { "x-erxes-ai-assistant-secret": env.OPENCLAW_SHARED_SECRET }
    : {};

export const startOpenClawAssistantJob = async (
  input: AskAssistantInput & { jobKey: string },
): Promise<AssistantRuntimeJob> => {
  const response = await fetch(
    `${normalizeOpenClawUrl(input.openclawUrl)}/api/erxes-ai-assistant/ask-async`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...runtimeSecretHeaders(),
      },
      body: JSON.stringify({
        tenantId: input.tenantId,
        assistantId: input.assistantId,
        question: input.question,
        user: input.user,
        discord: input.discord,
        source: "discord",
        jobKey: input.jobKey,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `OpenClaw job start failed with status ${response.status}: ${sanitizeRemoteMessage(text)}`,
    );
  }

  return JSON.parse(text) as AssistantRuntimeJob;
};

export const getOpenClawAssistantJob = async (
  openclawUrl: string,
  jobId: string,
): Promise<AssistantRuntimeJob> => {
  const response = await fetch(
    `${normalizeOpenClawUrl(openclawUrl)}/api/erxes-ai-assistant/jobs/${encodeURIComponent(jobId)}`,
    {
      headers: { ...runtimeSecretHeaders() },
      signal: AbortSignal.timeout(20_000),
    },
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `OpenClaw job status failed with status ${response.status}: ${sanitizeRemoteMessage(text)}`,
    );
  }

  return JSON.parse(text) as AssistantRuntimeJob;
};

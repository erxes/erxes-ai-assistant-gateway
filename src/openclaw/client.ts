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
  };
};

type FlexibleOpenClawResponse = {
  answer?: unknown;
  message?: unknown;
  content?: unknown;
  response?: unknown;
};

const normalizeOpenClawUrl = (openclawUrl: string) =>
  openclawUrl.replace(/\/+$/, "");

const parseAssistantAnswer = (body: FlexibleOpenClawResponse) => {
  const value = body.answer ?? body.message ?? body.content ?? body.response;

  if (typeof value === "string" && value.trim().length > 0) {
    const answer = value.trim();

    if (answer.length > env.ERXES_ASSISTANT_REPLY_MAX_CHARS) {
      return `${answer.slice(0, env.ERXES_ASSISTANT_REPLY_MAX_CHARS - 20)}\n\n[truncated]`;
    }

    return answer;
  }

  return "The assistant returned an empty response.";
};

export const askOpenClawAssistant = async (input: AskAssistantInput) => {
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
      `OpenClaw request failed with status ${response.status}: ${text}`,
    );
  }

  let body: FlexibleOpenClawResponse = {};

  if (text.length > 0) {
    try {
      body = JSON.parse(text) as FlexibleOpenClawResponse;
    } catch {
      throw new Error("OpenClaw returned invalid JSON");
    }
  }

  return parseAssistantAnswer(body);
};

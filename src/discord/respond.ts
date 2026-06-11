import { env, requireEnv } from "../config/env.js";

const discordApiBaseUrl = "https://discord.com/api/v10";

const trimDiscordContent = (content: string) => {
  const maxChars = env.ERXES_ASSISTANT_REPLY_MAX_CHARS;

  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, Math.max(0, maxChars - 20))}\n\n[truncated]`;
};

export const editOriginalInteractionResponse = async ({
  applicationId,
  interactionToken,
  content,
}: {
  applicationId?: string;
  interactionToken: string;
  content: string;
}) => {
  const resolvedApplicationId =
    applicationId && applicationId.length > 0
      ? applicationId
      : requireEnv("DISCORD_APPLICATION_ID");

  const response = await fetch(
    `${discordApiBaseUrl}/webhooks/${resolvedApplicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: trimDiscordContent(content),
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to edit Discord interaction response: ${response.status} ${body}`,
    );
  }
};


export const createFollowupMessage = async ({
  applicationId,
  interactionToken,
  content,
  files,
}: {
  applicationId?: string;
  interactionToken: string;
  content: string;
  files?: Array<{ attachment: Buffer; name: string }>;
}) => {
  const resolvedApplicationId =
    applicationId && applicationId.length > 0
      ? applicationId
      : requireEnv("DISCORD_APPLICATION_ID");

  const url = `${discordApiBaseUrl}/webhooks/${resolvedApplicationId}/${interactionToken}`;
  const payload = { content: trimDiscordContent(content) };

  let response: Response;

  if (files && files.length > 0) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));
    files.slice(0, 5).forEach((file, index) => {
      form.append(
        `files[${index}]`,
        new Blob([new Uint8Array(file.attachment)]),
        file.name,
      );
    });
    response = await fetch(url, { method: "POST", body: form });
  } else {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to send Discord follow-up message: ${response.status} ${body}`,
    );
  }
};

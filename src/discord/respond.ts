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


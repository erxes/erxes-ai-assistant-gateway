export type DiscordInteraction = {
  id: string;
  application_id?: string;
  token: string;
  type: number;
  guild_id?: string;
  channel_id?: string;
  member?: {
    user?: {
      id: string;
      username?: string;
      global_name?: string | null;
    };
  };
  user?: {
    id: string;
    username?: string;
    global_name?: string | null;
  };
  data?: {
    name?: string;
    options?: DiscordCommandOption[];
  };
};

export type DiscordCommandOption = {
  name: string;
  type: number;
  value?: string;
  options?: DiscordCommandOption[];
};

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
} as const;

export const getQuestionFromInteraction = (
  interaction: DiscordInteraction,
): string | undefined => {
  if (interaction.data?.name !== "assistant") {
    return undefined;
  }

  const questionOption = interaction.data.options?.find(
    (option) => option.name === "question",
  );

  return typeof questionOption?.value === "string"
    ? questionOption.value.trim()
    : undefined;
};

export const getDiscordUser = (interaction: DiscordInteraction) => {
  const user = interaction.member?.user ?? interaction.user;

  return {
    id: user?.id ?? "unknown",
    username: user?.global_name ?? user?.username ?? "Discord user",
  };
};

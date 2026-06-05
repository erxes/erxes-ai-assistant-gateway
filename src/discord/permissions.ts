export const defaultBotPermissions = "8";

export const isValidDiscordPermissionInteger = (value: string) =>
  /^(0|[1-9]\d*)$/.test(value);

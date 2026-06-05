export const defaultBotPermissions = "8";
export const administratorPermission = 8n;

export const isValidDiscordPermissionInteger = (value: string) =>
  /^(0|[1-9]\d*)$/.test(value);

export const hasAdministratorPermission = (permissions?: string) => {
  if (!permissions || !isValidDiscordPermissionInteger(permissions)) {
    return false;
  }

  return (BigInt(permissions) & administratorPermission) ===
    administratorPermission;
};

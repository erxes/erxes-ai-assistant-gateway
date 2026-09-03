export const administratorPermission = 8n;

// The shared bot only needs to inspect channels, create/configure text
// channels, send replies (including files/embeds), read reply history, and
// answer inside existing threads. Cron scheduling itself lives in the runtime
// and does not require an additional Discord permission.
export const requiredBotPermission =
  (1n << 4n) | // Manage Channels
  (1n << 10n) | // View Channels
  (1n << 11n) | // Send Messages
  (1n << 14n) | // Embed Links
  (1n << 15n) | // Attach Files
  (1n << 16n) | // Read Message History
  (1n << 38n); // Send Messages in Threads

export const defaultBotPermissions = requiredBotPermission.toString();

export const isValidDiscordPermissionInteger = (value: string) =>
  /^(0|[1-9]\d*)$/.test(value);

export const hasAdministratorPermission = (permissions?: string) => {
  if (!permissions || !isValidDiscordPermissionInteger(permissions)) {
    return false;
  }

  return (BigInt(permissions) & administratorPermission) ===
    administratorPermission;
};

export const hasRequiredBotPermissions = (permissions?: string) => {
  if (!permissions || !isValidDiscordPermissionInteger(permissions)) {
    return false;
  }

  const granted = BigInt(permissions);

  // Existing installations that were approved with Administrator remain
  // compatible; new installs request only requiredBotPermission.
  return (
    (granted & administratorPermission) === administratorPermission ||
    (granted & requiredBotPermission) === requiredBotPermission
  );
};

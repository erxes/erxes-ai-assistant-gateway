import { registerDiscordCommands } from "../src/discord/registerCommands.js";
import { logger } from "../src/lib/logger.js";

registerDiscordCommands()
  .then((result) => {
    logger.info("Discord slash commands registered", {
      scope: result.scope,
      guildId: result.guildId,
    });
  })
  .catch((error) => {
    logger.error("Discord slash command registration failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });


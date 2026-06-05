import { env, requireEnv } from "../config/env.js";

export const discordOAuthScopes = ["bot", "applications.commands"] as const;

export const buildDiscordInstallUrl = (state: string) => {
  const clientId = env.DISCORD_CLIENT_ID || requireEnv("DISCORD_APPLICATION_ID");
  const url = new URL("https://discord.com/oauth2/authorize");

  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", env.DISCORD_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", discordOAuthScopes.join(" "));
  url.searchParams.set("permissions", env.DISCORD_BOT_PERMISSIONS);
  url.searchParams.set("state", state);

  return url.toString();
};

export const validateReturnUrl = (returnUrl?: string) => {
  if (!returnUrl) {
    return undefined;
  }

  let parsedReturnUrl: URL;

  try {
    parsedReturnUrl = new URL(returnUrl);
  } catch {
    return undefined;
  }

  const allowed = env.ERXES_ALLOWED_RETURN_URLS.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  for (const allowedUrl of allowed) {
    try {
      const parsedAllowedUrl = new URL(allowedUrl);
      const sameOrigin = parsedAllowedUrl.origin === parsedReturnUrl.origin;
      const pathAllowed =
        parsedAllowedUrl.pathname === "/" ||
        parsedReturnUrl.pathname.startsWith(parsedAllowedUrl.pathname);

      if (sameOrigin && pathAllowed) {
        return parsedReturnUrl.toString();
      }
    } catch {
      continue;
    }
  }

  return undefined;
};

export const appendDiscordConnectionResult = (
  returnUrl: string,
  result:
    | { status: "success"; installationId: string }
    | { status: "error"; message: string },
) => {
  const url = new URL(returnUrl);

  url.searchParams.set("discordConnection", result.status);

  if (result.status === "success") {
    url.searchParams.set("installationId", result.installationId);
  } else {
    url.searchParams.set("message", result.message);
  }

  return url.toString();
};

export const successHtml = () => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Erxes AI Assistant Installed</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 720px; margin: 64px auto; padding: 0 24px; color: #172026; line-height: 1.5; }
      h1 { font-size: 28px; margin-bottom: 12px; }
      p { font-size: 16px; }
      code { background: #f4f6f8; padding: 2px 6px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <h1>Erxes AI Assistant bot installed successfully.</h1>
    <p>Next step: choose the Discord channel and map it to an assistant in Erxes Admin.</p>
  </body>
</html>`;

export const missingGuildHtml = () => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Erxes AI Assistant Install Needs a Server</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 720px; margin: 64px auto; padding: 0 24px; color: #172026; line-height: 1.5; }
      h1 { font-size: 28px; margin-bottom: 12px; }
      p { font-size: 16px; }
    </style>
  </head>
  <body>
    <h1>Discord did not return a server for this install.</h1>
    <p>Please restart the install from Erxes Admin and choose the Discord server where the official Erxes AI Assistant bot should be installed.</p>
  </body>
</html>`;

export const errorHtml = (message: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Erxes AI Assistant Install Failed</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 720px; margin: 64px auto; padding: 0 24px; color: #172026; line-height: 1.5; }
      h1 { font-size: 28px; margin-bottom: 12px; }
      p { font-size: 16px; }
    </style>
  </head>
  <body>
    <h1>Discord connection failed.</h1>
    <p>${message}</p>
  </body>
</html>`;

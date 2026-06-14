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
  // Explicitly install the app into a Discord server.
  url.searchParams.set("integration_type", "0");
  url.searchParams.set("state", state);

  return url.toString();
};

const parseCsv = (value?: string) =>
  (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const hostnameMatchesSuffix = (hostname: string, suffix: string) => {
  const normalizedSuffix = suffix.toLowerCase();

  // A suffix must start with "." so it can only match whole sub-labels.
  // This blocks tricks like "evil-erxes.io" (no leading dot boundary) and
  // "abc.erxes.io.evil.com" (the suffix is not at the end of the hostname).
  if (!normalizedSuffix.startsWith(".")) {
    return false;
  }

  return hostname.endsWith(normalizedSuffix);
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

  const hostname = parsedReturnUrl.hostname.toLowerCase();
  const origin = parsedReturnUrl.origin.toLowerCase();
  const protocol = parsedReturnUrl.protocol;

  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1";

  // Exact origin allowlist (scheme + host + port). No path restriction:
  // an allowed origin may redirect to any path under that origin.
  const allowedOrigins = parseCsv(env.ERXES_ALLOWED_RETURN_URLS).map((item) => {
    try {
      return new URL(item).origin.toLowerCase();
    } catch {
      return item.toLowerCase();
    }
  });

  if (allowedOrigins.includes(origin)) {
    return parsedReturnUrl.toString();
  }

  if (isLocalhost && (protocol === "http:" || protocol === "https:")) {
    return parsedReturnUrl.toString();
  }

  const allowedSecureSuffixes = parseCsv(
    env.ERXES_ALLOWED_RETURN_HOST_SUFFIXES,
  ).map((item) => item.toLowerCase());

  const allowedInsecureSuffixes = parseCsv(
    env.ERXES_ALLOWED_RETURN_INSECURE_HOST_SUFFIXES,
  ).map((item) => item.toLowerCase());

  if (
    protocol === "https:" &&
    allowedSecureSuffixes.some((suffix) =>
      hostnameMatchesSuffix(hostname, suffix),
    )
  ) {
    return parsedReturnUrl.toString();
  }

  if (
    protocol === "http:" &&
    allowedInsecureSuffixes.some((suffix) =>
      hostnameMatchesSuffix(hostname, suffix),
    )
  ) {
    return parsedReturnUrl.toString();
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

import { Router } from "express";

import { env } from "../config/env.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logger } from "../lib/logger.js";

/**
 * Google redirects here after the customer approves Drive access for their
 * assistant. This route only relays code+state to the deployer, which
 * verifies the signed state, exchanges the code and stores the credential.
 * It carries no secret of its own: the state is the authentication.
 */

export type ExchangeResult =
  | { ok: true; assistant: string; restarted?: boolean }
  | { ok: false; error: string; status: number };

export const relayGoogleOAuthCode = async (
  code: string,
  state: string,
  fetchImpl: typeof fetch = fetch,
  deployerUrl = env.DEPLOYER_URL,
): Promise<ExchangeResult> => {
  let res: Response;
  try {
    res = await fetchImpl(`${deployerUrl.replace(/\/$/, "")}/agents/google-oauth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, state }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { ok: false, error: "The assistant platform could not be reached. Please try again in a minute.", status: 502 };
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return { ok: false, error: String(json.error ?? `exchange failed (${res.status})`), status: res.status };
  }
  return { ok: true, assistant: String(json.assistant ?? ""), restarted: Boolean(json.restarted) };
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);

export const renderResultPage = (ok: boolean, message: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? "Google Drive connected" : "Google Drive not connected"}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;color:#1b1f24;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
  .card{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);padding:32px;max-width:520px;width:100%}
  h1{font-size:22px;margin:0 0 12px}
  p{line-height:1.5;margin:0 0 10px}
  .ok{color:#14733a}.bad{color:#a8231b}
  small{color:#5b6470}
</style></head>
<body><div class="card">
  <h1 class="${ok ? "ok" : "bad"}">${ok ? "✓ Google Drive connected" : "Google Drive was not connected"}</h1>
  <p>${escapeHtml(message)}</p>
  ${ok
    ? "<p>Таны туслах Google Drive-тай холбогдлоо. Одоо чатаа нээгээд, жишээ нь “Drive дээрх хавтсуудыг жагсаа” гэж бичээрэй.</p><p><small>You can close this tab. Your assistant restarts for about a minute to load the Drive tools.</small></p>"
    : "<p>Туслахаасаа шинэ холбоос авч дахин оролдоно уу.</p><p><small>Ask your assistant for a new link and try again.</small></p>"}
</div></body></html>`;

export const googleOAuthCallbackRouter = Router();

googleOAuthCallbackRouter.get(
  "/google/callback",
  asyncHandler(async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const denied = typeof req.query.error === "string" ? req.query.error : "";
    if (denied) {
      logger.info("google-oauth: user denied consent", { error: denied });
      res.status(400).type("html").send(renderResultPage(false, "Access was not granted. Nothing was changed."));
      return;
    }
    if (!code || !state) {
      res.status(400).type("html").send(renderResultPage(false, "This link is incomplete."));
      return;
    }
    const result = await relayGoogleOAuthCode(code, state);
    if (!result.ok) {
      logger.warn("google-oauth: exchange refused", { status: result.status, error: result.error });
      res.status(result.status >= 500 ? 502 : 400).type("html").send(renderResultPage(false, result.error));
      return;
    }
    logger.info("google-oauth: drive connected", { assistant: result.assistant, restarted: result.restarted });
    res.status(200).type("html").send(renderResultPage(true, "Your assistant now has access to your Google Drive."));
  }),
);

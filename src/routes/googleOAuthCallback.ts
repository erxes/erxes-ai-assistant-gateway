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

/**
 * The customer reaches this page straight from Google's unverified-app warning,
 * so an unbranded card reads as phishing. The erxes mark, the product name and
 * the assistant that was actually connected are what tie it back to the chat
 * they started in. The logo is inlined: an external asset that fails to load
 * would leave exactly the blank page this is meant to avoid.
 */
const ERXES_MARK = `<svg class="mark" viewBox="0 0 23 33" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12.6796 16.7509C16.1909 11.598 19.4964 6.1423 22.4233 0.5C19.092 4.26153 15.1649 9.73484 11.5688 15.1003C9.66263 12.3476 7.38208 9.39684 4.76955 6.63271C7.3583 11.4228 8.66767 14.0594 10.459 16.7696C5.01156 25.0008 0.57666 32.5 0.57666 32.5C4.31137 28.1879 8.03367 23.4404 11.5688 18.3714C13.084 20.4647 15.0439 22.8349 18.1756 26.3911C18.1694 26.386 16.2147 22.1278 12.6796 16.7509Z" fill="#fff"/></svg>`;

/** "assistant-purify-test" is the namespace; the customer knows it as "purify-test". */
export const assistantDisplayName = (assistant: string): string =>
  assistant.replace(/^assistant-/, "").trim();

export const renderResultPage = (ok: boolean, message: string, assistant = ""): string => {
  const name = assistantDisplayName(assistant);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? "Google Drive connected" : "Google Drive not connected"} · erxes</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;color:#1b1f24;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
  .card{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);padding:32px;max-width:520px;width:100%}
  .brand{display:flex;align-items:center;gap:10px;margin:0 0 20px}
  .badge{background:#7c3aed;border-radius:8px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;flex:none}
  .mark{width:15px;height:21px;display:block}
  .brand span{font-weight:600;font-size:15px;letter-spacing:.2px}
  h1{font-size:22px;margin:0 0 12px}
  p{line-height:1.5;margin:0 0 10px}
  .ok{color:#14733a}.bad{color:#a8231b}
  .who{background:#f6f4fe;border:1px solid #e6e0fb;border-radius:8px;padding:10px 12px;margin:0 0 14px;font-size:14px}
  small{color:#5b6470}
</style></head>
<body><div class="card">
  <div class="brand"><span class="badge">${ERXES_MARK}</span><span>erxes AI Assistant</span></div>
  <h1 class="${ok ? "ok" : "bad"}">${ok ? "✓ Google Drive connected" : "Google Drive was not connected"}</h1>
  ${ok && name ? `<p class="who">Connected to your assistant <strong>${escapeHtml(name)}</strong>.</p>` : ""}
  <p>${escapeHtml(message)}</p>
  ${ok
    ? "<p>Таны туслах Google Drive-тай холбогдлоо. Одоо чатаа нээгээд, жишээ нь “Drive дээрх хавтсуудыг жагсаа” гэж бичээрэй.</p><p><small>You can close this tab. Your assistant restarts for about a minute to load the Drive tools.</small></p>"
    : "<p>Туслахаасаа шинэ холбоос авч дахин оролдоно уу.</p><p><small>Ask your assistant for a new link and try again.</small></p>"}
</div></body></html>`;
};

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
    // Say what was granted, not just that something was: the consent covers
    // organising files, not only reading them.
    res
      .status(200)
      .type("html")
      .send(
        renderResultPage(
          true,
          "It can now find, read and organise the files in your Google Drive. You can disconnect it at any time from your Google account, or by asking erxes support.",
          result.assistant,
        ),
      );
  }),
);

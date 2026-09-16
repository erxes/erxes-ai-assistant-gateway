import assert from "node:assert/strict";
import { test } from "node:test";

import { relayGoogleOAuthCode, renderResultPage } from "../src/routes/googleOAuthCallback.js";

test("relay posts code+state to the deployer exchange route and maps the answer", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const ok = await relayGoogleOAuthCode("4/abc", "st.ate", (async (url: any, init: any) => {
    calls.push({ url: String(url), body: String(init.body) });
    return new Response(JSON.stringify({ ok: true, assistant: "assistant-purify-test", restarted: true }), { status: 200 });
  }) as any, "http://deployer:4200/");
  assert.deepEqual(ok, { ok: true, assistant: "assistant-purify-test", restarted: true });
  assert.equal(calls[0].url, "http://deployer:4200/agents/google-oauth/exchange");
  assert.deepEqual(JSON.parse(calls[0].body), { code: "4/abc", state: "st.ate" });

  const refused = await relayGoogleOAuthCode("x", "y", (async () => new Response(JSON.stringify({ error: "state expired; ask the assistant for a new link" }), { status: 400 })) as any, "http://d");
  assert.ok(!refused.ok && refused.status === 400 && refused.error.includes("expired"));

  const down = await relayGoogleOAuthCode("x", "y", (async () => { throw new Error("ECONNREFUSED"); }) as any, "http://d");
  assert.ok(!down.ok && down.status === 502);
});

test("the result page escapes the message and never echoes a code or state", () => {
  const html = renderResultPage(false, "<script>alert(1)</script> & done");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; done"));
  assert.ok(!html.includes("<script>alert"));
  assert.ok(renderResultPage(true, "ok").includes("Google Drive connected"));
});

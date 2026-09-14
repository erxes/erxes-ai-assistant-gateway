import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildFollowupHostToken,
  chunkFollowupText,
  FOLLOWUP_CHUNK_CHARS,
  parseFollowupPayload,
  validateFollowupHostToken,
} from "../src/routes/discordFollowup.js";

const secret = "synthetic-followup-secret";
const host = "assistant-purify-test.assistant.erxes.io";

test("follow-up host token matches the cron webhook host token scheme", () => {
  const token = buildFollowupHostToken(host, secret);
  assert.match(token, /^[a-f0-9]{32}$/);
  assert.equal(validateFollowupHostToken(token, host, secret), true);
  assert.equal(validateFollowupHostToken(token, "other.assistant.erxes.io", secret), false);
  assert.equal(validateFollowupHostToken("", host, secret), false);
  assert.equal(validateFollowupHostToken(token, host, ""), false);
});

test("payload validation keeps only well-formed ids, files and text", () => {
  const fileId = "3f1c2a9e-1b2c-4d5e-8f90-1234567890ab";
  const parsed = parseFollowupPayload({
    channelId: " 1533691379459293338 ",
    text: "  Contract ready  ",
    files: [
      { fileId, filename: "geree.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 41513 },
      { fileId: "../etc/passwd", filename: "x" },
      { fileId, filename: "" },
    ],
    fileErrors: ["big.zip: too large", 42],
    replyToMessageId: "1548933524688474172",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.payload.channelId, "1533691379459293338");
  assert.equal(parsed.payload.text, "Contract ready");
  assert.deepEqual(parsed.payload.files.map((f) => f.filename), ["geree.docx"]);
  assert.deepEqual(parsed.payload.fileErrors, ["big.zip: too large"]);
  assert.equal(parsed.payload.replyToMessageId, "1548933524688474172");
  assert.equal(parsed.payload.threadId, undefined);
});

test("a thread id is accepted and validated", () => {
  const ok = parseFollowupPayload({
    channelId: "1533691379459293338",
    threadId: "1548933524688474172",
    text: "done",
  });
  assert.equal(ok.ok && ok.payload.threadId, "1548933524688474172");
  const bad = parseFollowupPayload({
    channelId: "1533691379459293338",
    threadId: "nope",
    text: "done",
  });
  assert.equal(bad.ok && bad.payload.threadId, undefined);
});

test("payload validation rejects empty posts and bad channels", () => {
  assert.deepEqual(parseFollowupPayload({ channelId: "abc", text: "hi" }), { ok: false, error: "invalid channelId" });
  assert.deepEqual(parseFollowupPayload({ channelId: "1533691379459293338", text: "   " }), { ok: false, error: "nothing to post" });
  assert.deepEqual(parseFollowupPayload("nope"), { ok: false, error: "body must be an object" });
  const bad = parseFollowupPayload({ channelId: "1533691379459293338", text: "x", replyToMessageId: "not-an-id" });
  assert.equal(bad.ok && bad.payload.replyToMessageId, undefined);
});

test("long follow-ups are chunked under Discord's limit at line breaks", () => {
  const para = "line ".repeat(60).trim();
  const text = Array.from({ length: 12 }, (_, i) => `${i}: ${para}`).join("\n");
  const chunks = chunkFollowupText(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= FOLLOWUP_CHUNK_CHARS + 20);
  assert.equal(chunks.join("\n").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
  assert.deepEqual(chunkFollowupText("  short  "), ["short"]);
  assert.deepEqual(chunkFollowupText(""), []);
});

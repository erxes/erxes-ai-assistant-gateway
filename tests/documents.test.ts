import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";

import { normalizeDiscordAttachments } from "../src/discord/attachments.js";
import {
  documentBufferToText,
  extractDocumentText,
  isDocumentAttachment,
} from "../src/discord/documents.js";

const DOCX_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const docx = (bodyXml: string): Uint8Array =>
  zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${bodyXml}</w:body></w:document>`,
    ),
  });

const p = (...runs: string[]) =>
  `<w:p><w:pPr/>${runs.map((r) => `<w:r><w:t xml:space="preserve">${r}</w:t></w:r>`).join("")}</w:p>`;

test("isDocumentAttachment matches by MIME type and by extension", () => {
  assert.equal(isDocumentAttachment("x.bin", DOCX_TYPE), true);
  assert.equal(isDocumentAttachment("Report (1).docx", "application/octet-stream"), true);
  assert.equal(isDocumentAttachment("old.doc", null), true);
  assert.equal(isDocumentAttachment("deck.pptx", null), false);
  assert.equal(isDocumentAttachment("report.pdf", "application/pdf"), false);
});

test("docx is no longer a passthrough file type", () => {
  const { supported, skipped } = normalizeDiscordAttachments([
    {
      filename: "report.docx",
      contentType: DOCX_TYPE,
      size: 13819,
      url: "https://cdn.discordapp.com/attachments/1/2/report.docx",
    },
  ]);
  assert.equal(supported.length, 0);
  assert.deepEqual(skipped, [{ filename: "report.docx", reason: "unsupported-type" }]);
});

test("paragraphs, split runs, tabs, breaks, tables and entities are extracted", () => {
  const body =
    p("Title") +
    p("Hel", "lo ", "world") +
    `<w:p><w:r><w:t>Col A</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Col B</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>Line 1</w:t><w:br/><w:t>Line 2</w:t></w:r></w:p>` +
    `<w:tbl><w:tr><w:tc>${p("Cell 1")}</w:tc><w:tc>${p("Cell 2")}</w:tc></w:tr></w:tbl>` +
    p("Fish &amp; Chips &lt;b&gt; &#1052;") +
    p("   ") +
    p("End");
  const text = documentBufferToText(docx(body), "sample.docx");
  assert.equal(
    text,
    [
      "[Document sample.docx]",
      ["Title", "Hello world", "Col A\tCol B", "Line 1\nLine 2", "Cell 1", "Cell 2", "Fish & Chips <b> М", "End"].join("\n"),
    ].join("\n\n"),
  );
});

test("a real LibreOffice-generated docx extracts its text", () => {
  const buf = new Uint8Array(readFileSync(new URL("./fixtures/hermes-extension.docx", import.meta.url)));
  const text = documentBufferToText(buf, "hermes-extension.docx");
  assert.match(text, /^\[Document hermes-extension\.docx\]/);
  assert.match(text, /Hermes WebUI Work OS Extension/);
  assert.match(text, /Goal: extend the Hermes web UI\./);
  assert.match(text, /Item A\tValue 1/);
  assert.match(text, /Монгол текст & <тест>/);
});

test("long documents are truncated with a note", () => {
  const body = Array.from({ length: 500 }, (_, i) => p(`Paragraph ${i} ${"x".repeat(200)}`)).join("");
  const text = documentBufferToText(docx(body), "long.docx");
  assert.ok(text.length < 41_000);
  assert.match(text, /\[\.\.\. truncated: document is longer than 40000 characters\]$/);
});

test("legacy .doc, corrupt files and empty bodies degrade to notes", () => {
  const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  assert.equal(
    documentBufferToText(ole, "old.doc"),
    "[Document old.doc: only .docx is supported (this looks like a legacy .doc).]",
  );
  assert.equal(
    documentBufferToText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), "bad.docx"),
    "[Document bad.docx: could not be read (corrupt or unsupported file).]",
  );
  assert.equal(
    documentBufferToText(zipSync({ "word/styles.xml": strToU8("<x/>") }), "nobody.docx"),
    "[Document nobody.docx: no document body found.]",
  );
  assert.equal(
    documentBufferToText(docx(`<w:p><w:r><w:drawing/></w:r></w:p>`), "img.docx"),
    "[Document img.docx: no readable text (likely images only).]",
  );
});

test("extractDocumentText only fetches Discord CDN URLs and enforces size caps", async () => {
  assert.equal(
    await extractDocumentText({ filename: "x.docx", url: "https://evil.example/x.docx", size: 10 }),
    "[Document x.docx: could not be read (invalid source).]",
  );
  assert.equal(
    await extractDocumentText({
      filename: "x.docx",
      url: "https://cdn.discordapp.com/attachments/1/2/x.docx",
      size: 5 * 1024 * 1024,
    }),
    "[Document x.docx: too large to read here (limit 4MB).]",
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(docx(p("Fetched body")), { status: 200 })) as typeof fetch;
  try {
    const text = await extractDocumentText({
      filename: "x.docx",
      url: "https://cdn.discordapp.com/attachments/1/2/x.docx",
      contentType: DOCX_TYPE,
      size: 100,
    });
    assert.equal(text, "[Document x.docx]\n\nFetched body");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import { strToU8 as _u8, zipSync as _zip } from "fflate";
import {
  handleDiscordMessage,
  INLINE_ATTACHMENT_FRAME,
  NO_MESSAGE_ATTACHMENT_ASK,
} from "../src/discord/messageGateway.js";
import { MessageType } from "discord.js";

const docxAttachmentMessage = (content: string) => {
  const replies: unknown[] = [];
  const message = {
    id: "m1",
    guildId: "g1",
    channelId: "c1",
    content,
    webhookId: null,
    system: false,
    type: MessageType.Default,
    author: { id: "u1", username: "u", bot: false },
    attachments: {
      size: 1,
      map: (fn: (a: unknown) => unknown) => [
        fn({
          name: "brief.docx",
          contentType: DOCX_TYPE,
          size: 100,
          url: "https://cdn.discordapp.com/attachments/1/2/brief.docx",
        }),
      ],
    },
    channel: { sendTyping: async () => undefined, send: async () => undefined },
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
  } as any;
  return { message, replies };
};

const withDocxFetch = async (fn: () => Promise<void>) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      _zip({
        "word/document.xml": _u8(
          `<w:document><w:body><w:p><w:r><w:t>Build the whole system now.</w:t></w:r></w:p></w:body></w:document>`,
        ),
      }),
      { status: 200 },
    )) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const gatewayDeps = (capture: (q: string) => void) => ({
  logger: { error: () => undefined, info: () => undefined, warn: () => undefined } as any,
  findBinding: async () =>
    ({
      assistantId: "a1",
      tenantId: "t1",
      guildId: "g1",
      channelId: "c1",
      enabled: true,
      responseMode: "all_messages",
    }) as any,
  askAssistant: async (input: { question: string }) => {
    capture(input.question);
    return "ok";
  },
});

test("an inlined document is framed as reference material under the user's message", async () => {
  await withDocxFetch(async () => {
    const fixture = docxAttachmentMessage("what is in here specifically");
    let question = "";
    await handleDiscordMessage(fixture.message, gatewayDeps((q) => (question = q)));
    assert.equal(
      question,
      [
        "what is in here specifically",
        INLINE_ATTACHMENT_FRAME,
        "[Document brief.docx]\n\nBuild the whole system now.",
      ].join("\n\n"),
    );
  });
});

test("a file sent without a message gets an explicit ask instead of the bare contents", async () => {
  await withDocxFetch(async () => {
    const fixture = docxAttachmentMessage("");
    let question = "";
    await handleDiscordMessage(fixture.message, gatewayDeps((q) => (question = q)));
    assert.ok(question.startsWith(NO_MESSAGE_ATTACHMENT_ASK + "\n\n" + INLINE_ATTACHMENT_FRAME));
    assert.match(question, /Build the whole system now\.$/);
  });
});

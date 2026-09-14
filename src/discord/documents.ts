import { unzipSync, strFromU8 } from "fflate";

import { isAllowedDiscordAttachmentUrl } from "./attachments.js";

// Word (.docx) -> plain text for inlining into the prompt.
//
// Mirrors presentations.ts: only Discord CDN URLs are fetched, hard caps on
// declared and downloaded size, output caps on paragraphs/chars, and every
// failure degrades to a short bracketed note instead of throwing.
//
// A .docx is a ZIP. Body text lives in <w:t> runs grouped by <w:p> paragraphs
// inside word/document.xml; tables are just paragraphs inside <w:tc> cells, so
// paragraph-level extraction already covers them. The runtime rejects docx as
// an input_file ("Unsupported file MIME type"), which is why the gateway has to
// turn it into text before the message leaves.

const DOCUMENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/msword", // legacy .doc (OLE, not a ZIP — rejected below)
]);
const DOCUMENT_EXT_RE = /\.(docx|doc)$/i;

export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PARAGRAPHS = 2_000;
const MAX_TOTAL_CHARS = 40_000;

export const isDocumentAttachment = (
  filename?: string | null,
  contentType?: string | null,
): boolean => {
  const ct = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  if (ct && DOCUMENT_TYPES.has(ct)) return true;
  return DOCUMENT_EXT_RE.test(filename ?? "");
};

const decodeXmlEntities = (value: string): string =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&"); // last: otherwise &amp;lt; double-decodes

const paragraphXmlToText = (xml: string): string => {
  // Tabs and manual line breaks are empty elements, not text runs; keep them
  // so columns and addresses do not collapse into one word.
  const withBreaks = xml
    .replace(/<w:tab\s*\/>/g, "\t")
    .replace(/<w:br(?:\s[^>]*)?\/>/g, "\n")
    .replace(/<w:cr\s*\/>/g, "\n");
  const runs: string[] = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|(\t|\n)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withBreaks)) !== null) {
    runs.push(m[1] !== undefined ? decodeXmlEntities(m[1]) : (m[2] ?? ""));
  }
  return runs.join("").replace(/[ \t]+\n/g, "\n").trim();
};

export const documentBufferToText = (buf: Uint8Array, name: string): string => {
  // ZIP magic. Legacy .doc is an OLE compound file and will not match — say so
  // plainly rather than emitting garbage.
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    return `[Document ${name}: only .docx is supported (this looks like a legacy .doc).]`;
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf, {
      filter: (f) => f.name === "word/document.xml",
    });
  } catch {
    return `[Document ${name}: could not be read (corrupt or unsupported file).]`;
  }

  const xml = files["word/document.xml"];
  if (!xml) {
    return `[Document ${name}: no document body found.]`;
  }

  const body = strFromU8(xml);
  const paragraphRe = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
  const paragraphs: string[] = [];
  let totalParagraphs = 0;
  let total = 0;
  let truncated = false;
  let m: RegExpExecArray | null;
  while ((m = paragraphRe.exec(body)) !== null) {
    totalParagraphs += 1;
    const text = paragraphXmlToText(m[1] ?? "");
    if (!text) continue;
    if (paragraphs.length >= MAX_PARAGRAPHS || total + text.length > MAX_TOTAL_CHARS) {
      truncated = true;
      break;
    }
    paragraphs.push(text);
    total += text.length + 1;
  }

  if (paragraphs.length === 0) {
    return totalParagraphs === 0
      ? `[Document ${name}: no paragraphs found.]`
      : `[Document ${name}: no readable text (likely images only).]`;
  }

  const header = `[Document ${name}]`;
  const parts = [header, paragraphs.join("\n")];
  if (truncated) {
    parts.push(`[... truncated: document is longer than ${MAX_TOTAL_CHARS} characters]`);
  }
  return parts.join("\n\n");
};

export const extractDocumentText = async (att: {
  filename: string;
  url: string;
  contentType?: string | null;
  size: number;
}): Promise<string> => {
  const name = att.filename || "document";

  if (!isAllowedDiscordAttachmentUrl(att.url)) {
    return `[Document ${name}: could not be read (invalid source).]`;
  }
  if (att.size <= 0 || att.size > MAX_DOCUMENT_BYTES) {
    return `[Document ${name}: too large to read here (limit 4MB).]`;
  }

  let buf: Uint8Array;
  try {
    const resp = await fetch(att.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`http ${resp.status}`);
    const ab = await resp.arrayBuffer();
    // Re-check AFTER download: the declared size is attacker-controlled.
    if (ab.byteLength > MAX_DOCUMENT_BYTES) {
      return `[Document ${name}: too large to read here (limit 4MB).]`;
    }
    buf = new Uint8Array(ab);
  } catch {
    return `[Document ${name}: could not be downloaded.]`;
  }

  try {
    return documentBufferToText(buf, name);
  } catch {
    return `[Document ${name}: could not be read.]`;
  }
};

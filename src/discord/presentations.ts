import { unzipSync, strFromU8 } from "fflate";

import { isAllowedDiscordAttachmentUrl } from "./attachments.js";

// PowerPoint (.pptx) -> plain text for inlining into the prompt.
//
// Mirrors spreadsheets.ts deliberately: only Discord CDN URLs are fetched, hard
// caps on both the declared size and the downloaded bytes, output caps on
// slides/chars, and every failure degrades to a short bracketed note instead of
// throwing — a bad deck must never break the message.
//
// A .pptx is a ZIP. Slide text lives in <a:t> runs inside ppt/slides/slideN.xml,
// so no layout parsing or rendering is needed: the model only wants the words.

const PRESENTATION_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/vnd.ms-powerpoint", // legacy .ppt (OLE, not a ZIP — rejected below)
]);
const PRESENTATION_EXT_RE = /\.(pptx|ppt)$/i;

export const MAX_PRESENTATION_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_SLIDES = 60;
const MAX_CHARS_PER_SLIDE = 2_000;
const MAX_TOTAL_CHARS = 40_000;

export const isPresentationAttachment = (
  filename?: string | null,
  contentType?: string | null,
): boolean => {
  const ct = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  if (ct && PRESENTATION_TYPES.has(ct)) return true;
  return PRESENTATION_EXT_RE.test(filename ?? "");
};

const decodeXmlEntities = (value: string): string =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&"); // last: otherwise &amp;lt; double-decodes

// slide10 must sort after slide9, so compare the numeric suffix, not the string.
const slideIndex = (path: string): number => {
  const m = /slide(\d+)\.xml$/i.exec(path);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

const slideXmlToText = (xml: string): string => {
  const runs: string[] = [];
  // <a:t> holds every visible text run: titles, bullets, table cells, notes.
  const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const t = decodeXmlEntities(m[1] ?? "").trim();
    if (t) runs.push(t);
  }
  // Paragraph breaks are lost in <a:t> alone; newline per run reads better than
  // one run-on line and costs nothing.
  return runs.join("\n").slice(0, MAX_CHARS_PER_SLIDE);
};

export const presentationBufferToText = (
  buf: Uint8Array,
  name: string,
): string => {
  // ZIP magic. Legacy .ppt is an OLE compound file and will not match — say so
  // plainly rather than emitting garbage.
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    return `[Presentation ${name}: only .pptx is supported (this looks like a legacy .ppt).]`;
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf, {
      filter: (f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f.name),
    });
  } catch {
    return `[Presentation ${name}: could not be read (corrupt or unsupported file).]`;
  }

  const paths = Object.keys(files).sort((a, b) => slideIndex(a) - slideIndex(b));
  if (paths.length === 0) {
    return `[Presentation ${name}: no slides found.]`;
  }

  const shown = paths.slice(0, MAX_SLIDES);
  const parts: string[] = [];
  let total = 0;

  for (let i = 0; i < shown.length; i += 1) {
    const path = shown[i]!;
    const text = slideXmlToText(strFromU8(files[path]!));
    if (!text) continue;
    const block = `--- Slide ${slideIndex(shown[i]!)} ---\n${text}`;
    if (total + block.length > MAX_TOTAL_CHARS) {
      parts.push(`[... truncated: presentation is longer than ${MAX_TOTAL_CHARS} characters]`);
      break;
    }
    parts.push(block);
    total += block.length;
  }

  if (parts.length === 0) {
    return `[Presentation ${name}: ${paths.length} slide(s), no readable text (likely images only).]`;
  }

  const omitted = paths.length - shown.length;
  const header = `[Presentation ${name} — ${paths.length} slide(s)${
    omitted > 0 ? `, showing first ${shown.length}` : ""
  }]`;

  return [header, ...parts].join("\n\n");
};

export const extractPresentationText = async (att: {
  filename: string;
  url: string;
  contentType?: string | null;
  size: number;
}): Promise<string> => {
  const name = att.filename || "presentation";

  if (!isAllowedDiscordAttachmentUrl(att.url)) {
    return `[Presentation ${name}: could not be read (invalid source).]`;
  }
  if (att.size <= 0 || att.size > MAX_PRESENTATION_BYTES) {
    return `[Presentation ${name}: too large to read here (limit 4MB).]`;
  }

  let buf: Uint8Array;
  try {
    const resp = await fetch(att.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`http ${resp.status}`);
    const ab = await resp.arrayBuffer();
    // Re-check AFTER download: the declared size is attacker-controlled.
    if (ab.byteLength > MAX_PRESENTATION_BYTES) {
      return `[Presentation ${name}: too large to read here (limit 4MB).]`;
    }
    buf = new Uint8Array(ab);
  } catch {
    return `[Presentation ${name}: could not be downloaded.]`;
  }

  try {
    return presentationBufferToText(buf, name);
  } catch {
    return `[Presentation ${name}: could not be read.]`;
  }
};

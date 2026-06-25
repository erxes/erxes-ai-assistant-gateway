import ExcelJS from "exceljs";

import { logger } from "../lib/logger.js";
import {
  isAllowedDiscordAttachmentUrl,
  normalizeContentType,
} from "./attachments.js";

// The managed runtime / Kimi cannot read binary spreadsheets (xlsx is not a
// supported document type, and the image has no xlsx tooling). So the gateway
// converts an uploaded spreadsheet to CSV text and inlines it into the prompt.
//
// Untrusted-file safety: only Discord CDN URLs are fetched, hard size cap on
// both the declared size and the downloaded bytes, a parse timeout, output caps
// on sheets/rows/cols/chars, and everything is wrapped so a bad file degrades to
// a short note instead of crashing the request.

const SPREADSHEET_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel.sheet.macroenabled.12", // .xlsm
  "application/vnd.ms-excel", // .xls (legacy BIFF — exceljs may reject; handled)
]);
const SPREADSHEET_EXT_RE = /\.(xlsx|xlsm|xls)$/i;

export const MAX_SPREADSHEET_BYTES = 4 * 1024 * 1024;
const MAX_SHEETS = 8;
const MAX_ROWS_PER_SHEET = 500;
const MAX_COLS = 50;
const MAX_TOTAL_CHARS = 40_000;
const CELL_MAX = 500;
const FETCH_TIMEOUT_MS = 15_000;
const PARSE_TIMEOUT_MS = 15_000;

export const isSpreadsheetAttachment = (
  filename: unknown,
  contentType: unknown,
): boolean => {
  const ct = normalizeContentType(contentType);
  if (ct && SPREADSHEET_TYPES.has(ct)) return true;
  // Some Discord uploads arrive as application/octet-stream — fall back to ext.
  return typeof filename === "string" && SPREADSHEET_EXT_RE.test(filename);
};

// Plain text files (csv/txt/md/json/html...). The model reads INLINE text
// reliably but treats file attachments (input_file) inconsistently, so these are
// inlined into the prompt too — same proven path as converted spreadsheets.
const INLINE_TEXT_TYPES = new Set([
  "text/csv",
  "text/plain",
  "text/markdown",
  "application/json",
  "text/html",
  "text/tab-separated-values",
]);
const INLINE_TEXT_EXT_RE = /\.(csv|tsv|txt|md|markdown|json|html?|log|yaml|yml)$/i;
const MAX_TEXT_INLINE_CHARS = 40_000;

export const isInlineTextAttachment = (
  filename: unknown,
  contentType: unknown,
): boolean => {
  const ct = normalizeContentType(contentType);
  if (ct && INLINE_TEXT_TYPES.has(ct)) return true;
  return typeof filename === "string" && INLINE_TEXT_EXT_RE.test(filename);
};

export const extractTextFile = async (att: {
  filename: string;
  url: string;
  size: number;
}): Promise<string> => {
  const name = att.filename || "file";
  if (!isAllowedDiscordAttachmentUrl(att.url)) {
    return `[File ${name}: could not be read (invalid source).]`;
  }
  if (att.size <= 0 || att.size > MAX_SPREADSHEET_BYTES) {
    return `[File ${name}: too large to read here (limit 4MB).]`;
  }
  let text: string;
  try {
    const resp = await fetch(att.url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) throw new Error(`http ${resp.status}`);
    text = await resp.text();
  } catch (error) {
    logger.info("text attachment download failed", {
      filename: name,
      error: error instanceof Error ? error.message : String(error),
    });
    return `[File ${name}: couldn't download it to read.]`;
  }
  let truncated = false;
  if (text.length > MAX_TEXT_INLINE_CHARS) {
    text = text.slice(0, MAX_TEXT_INLINE_CHARS);
    truncated = true;
  }
  return `[File: ${name}]\n${text}${truncated ? "\n(… file truncated)" : ""}`;
};

const csvCell = (value: unknown): string => {
  let s: string;
  if (value === null || value === undefined) {
    s = "";
  } else if (value instanceof Date) {
    s = value.toISOString();
  } else if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.text === "string") s = o.text;
    else if (o.result !== undefined && o.result !== null) s = String(o.result);
    else if (Array.isArray(o.richText))
      s = (o.richText as Array<{ text?: string }>).map((r) => r.text ?? "").join("");
    else if (typeof o.hyperlink === "string") s = String(o.text ?? o.hyperlink);
    else s = "";
  } else {
    s = String(value);
  }
  s = s.slice(0, CELL_MAX).replace(/\r?\n/g, " ");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const extractSpreadsheetText = async (att: {
  filename: string;
  url: string;
  contentType?: string | null;
  size: number;
}): Promise<string> => {
  const name = att.filename || "spreadsheet";
  if (!isAllowedDiscordAttachmentUrl(att.url)) {
    return `[Spreadsheet ${name}: could not be read (invalid source).]`;
  }
  if (att.size <= 0 || att.size > MAX_SPREADSHEET_BYTES) {
    return `[Spreadsheet ${name}: too large to read here (limit 4MB).]`;
  }

  let buf: Buffer;
  try {
    const resp = await fetch(att.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`http ${resp.status}`);
    const ab = await resp.arrayBuffer();
    if (ab.byteLength > MAX_SPREADSHEET_BYTES) throw new Error("body too large");
    buf = Buffer.from(ab);
  } catch (error) {
    logger.info("spreadsheet download failed", {
      filename: name,
      error: error instanceof Error ? error.message : String(error),
    });
    return `[Spreadsheet ${name}: couldn't download it to read.]`;
  }

  return spreadsheetBufferToText(buf, name);
};

// Parse an xlsx/xlsm buffer to capped CSV-ish text. Exported for testing.
export const spreadsheetBufferToText = async (
  buf: Buffer,
  name: string,
): Promise<string> => {
  try {
    const workbook = new ExcelJS.Workbook();
    await Promise.race([
      // exceljs ships its own Buffer typing; cast around the @types/node mismatch.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      workbook.xlsx.load(buf as any),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("parse timeout")), PARSE_TIMEOUT_MS),
      ),
    ]);

    const parts: string[] = [`[Spreadsheet: ${name}]`];
    let total = 0;
    let sheetCount = 0;
    let truncated = false;

    for (const ws of workbook.worksheets) {
      if (sheetCount >= MAX_SHEETS) {
        parts.push("(… more sheets omitted)");
        break;
      }
      sheetCount += 1;
      const lines: string[] = [`--- Sheet: ${ws.name} (${ws.actualRowCount} rows) ---`];
      let rowN = 0;
      ws.eachRow({ includeEmpty: false }, (row) => {
        if (rowN >= MAX_ROWS_PER_SHEET) return;
        rowN += 1;
        const values = (row.values as unknown[]).slice(1, 1 + MAX_COLS);
        lines.push(values.map(csvCell).join(","));
      });
      if (ws.actualRowCount > MAX_ROWS_PER_SHEET) {
        lines.push(`(… ${ws.actualRowCount - MAX_ROWS_PER_SHEET} more rows omitted)`);
      }
      const block = lines.join("\n");
      if (total + block.length > MAX_TOTAL_CHARS) {
        parts.push(block.slice(0, Math.max(0, MAX_TOTAL_CHARS - total)));
        truncated = true;
        break;
      }
      total += block.length;
      parts.push(block);
    }
    if (truncated) parts.push("(… spreadsheet truncated)");

    return parts.join("\n");
  } catch (error) {
    logger.info("spreadsheet parse failed", {
      filename: name,
      error: error instanceof Error ? error.message : String(error),
    });
    return `[Spreadsheet ${name}: couldn't read this file. If it's an old .xls, save it as .xlsx or CSV and resend.]`;
  }
};

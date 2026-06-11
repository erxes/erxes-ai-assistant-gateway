export type NormalizedDiscordAttachment = {
  kind: "image" | "file";
  filename: string;
  contentType: string;
  size: number;
  url: string;
};

export type SkippedDiscordAttachment = {
  filename: string;
  reason: "unsupported-type" | "too-large" | "invalid-url" | "too-many";
};

export type RawDiscordAttachment = {
  filename?: string | null;
  contentType?: string | null;
  size?: number | null;
  url?: string | null;
};

export const DISCORD_ATTACHMENT_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

export const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export const SUPPORTED_FILE_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "text/html",
]);

// OpenClaw enforces 10MB for images and 5MB for files; stay below both.
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;

export const sanitizeAttachmentFilename = (value: unknown): string => {
  if (typeof value !== "string") {
    return "attachment";
  }

  const clean = value
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[\\/]/g, "_")
    .replace(/\.{2,}/g, ".").replace(/^[._]+/, "")
    .trim()
    .slice(0, 100);

  return clean || "attachment";
};

export const normalizeContentType = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }

  return value.split(";")[0]?.trim().toLowerCase() ?? "";
};

export const isAllowedDiscordAttachmentUrl = (value: unknown): boolean => {
  if (typeof value !== "string" || !value) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      DISCORD_ATTACHMENT_HOSTS.has(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
};

// Discord attachment URLs carry signed query parameters; never log them.
export const redactAttachmentUrl = (value: string): string => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<invalid-url>";
  }
};

export const normalizeDiscordAttachments = (
  raw: RawDiscordAttachment[],
): {
  supported: NormalizedDiscordAttachment[];
  skipped: SkippedDiscordAttachment[];
} => {
  const supported: NormalizedDiscordAttachment[] = [];
  const skipped: SkippedDiscordAttachment[] = [];

  for (const attachment of raw) {
    const filename = sanitizeAttachmentFilename(attachment.filename);
    const contentType = normalizeContentType(attachment.contentType);
    const size = Number(attachment.size) || 0;

    const isImage = SUPPORTED_IMAGE_TYPES.has(contentType);
    const isFile = SUPPORTED_FILE_TYPES.has(contentType);

    if (!isImage && !isFile) {
      skipped.push({ filename, reason: "unsupported-type" });
      continue;
    }

    if (size <= 0 || size > (isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES)) {
      skipped.push({ filename, reason: "too-large" });
      continue;
    }

    if (!isAllowedDiscordAttachmentUrl(attachment.url)) {
      skipped.push({ filename, reason: "invalid-url" });
      continue;
    }

    if (supported.length >= MAX_ATTACHMENTS) {
      skipped.push({ filename, reason: "too-many" });
      continue;
    }

    supported.push({
      kind: isImage ? "image" : "file",
      filename,
      contentType,
      size,
      url: attachment.url as string,
    });
  }

  return { supported, skipped };
};

const REASON_MESSAGES: Record<SkippedDiscordAttachment["reason"], string> = {
  "unsupported-type": "This file type is not supported yet.",
  "too-large": "This file is too large to process here.",
  "invalid-url":
    "I couldn't download the attachment from Discord. Please try again.",
  "too-many": "Too many attachments in one message.",
};

export const attachmentRejectionMessage = (
  skipped: SkippedDiscordAttachment[],
): string => {
  const firstReason = skipped[0]?.reason ?? "unsupported-type";
  return REASON_MESSAGES[firstReason];
};

const REASON_LABELS: Record<SkippedDiscordAttachment["reason"], string> = {
  "unsupported-type": "unsupported type",
  "too-large": "too large",
  "invalid-url": "couldn't be downloaded",
  "too-many": "over the attachment limit",
};

export const skippedAttachmentsNote = (
  skipped: SkippedDiscordAttachment[],
): string =>
  `Note: I skipped ${skipped.length} attachment(s): ${skipped
    .map((item) => `${item.filename} (${REASON_LABELS[item.reason]})`)
    .join(", ")}.`;

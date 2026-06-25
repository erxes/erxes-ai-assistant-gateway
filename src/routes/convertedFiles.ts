import crypto from "node:crypto";
import { Router } from "express";

// Short-lived store for files the gateway converts (e.g. xlsx -> CSV). The
// runtime/OpenClaw fetches the file by its unguessable id and attaches it to the
// model as a normal file (so the web UI shows a clean file, not inline text).
// The id IS the capability — keep it unguessable + short-lived.

type StoredFile = {
  content: Buffer;
  contentType: string;
  filename: string;
  expiresAt: number;
};

const store = new Map<string, StoredFile>();
const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 1000;

const sweep = () => {
  const now = Date.now();
  for (const [id, f] of store) {
    if (f.expiresAt <= now) store.delete(id);
  }
};

export const storeConvertedFile = (
  content: string | Buffer,
  opts: { contentType: string; filename: string },
): { id: string; size: number } => {
  sweep();
  if (store.size >= MAX_ENTRIES) {
    // Evict the soonest-to-expire entry.
    let oldestId: string | undefined;
    let oldestAt = Infinity;
    for (const [id, f] of store) {
      if (f.expiresAt < oldestAt) {
        oldestAt = f.expiresAt;
        oldestId = id;
      }
    }
    if (oldestId) store.delete(oldestId);
  }
  const buf = Buffer.from(content);
  const id = crypto.randomBytes(18).toString("hex");
  store.set(id, {
    content: buf,
    contentType: opts.contentType,
    filename: opts.filename,
    expiresAt: Date.now() + TTL_MS,
  });
  return { id, size: buf.length };
};

export const convertedFilesRouter = Router();

convertedFilesRouter.get("/:id", (req, res) => {
  const file = store.get(String(req.params.id));
  if (!file || file.expiresAt <= Date.now()) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.setHeader("Content-Type", file.contentType);
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${file.filename.replace(/[^\w.\- ]/g, "_")}"`,
  );
  res.setHeader("Cache-Control", "no-store");
  res.send(file.content);
});

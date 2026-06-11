import { AssistantJob } from "../models/AssistantJob.js";
import type { AssistantJobRecord, AssistantJobStore } from "./jobRunner.js";

const isDuplicateKeyError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: number }).code === 11000;

export const mongoAssistantJobStore: AssistantJobStore = {
  async create(record: AssistantJobRecord) {
    try {
      const created = await AssistantJob.create({
        ...record,
        status: "started",
      });
      return { created: true, id: String(created._id) };
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return { created: false };
      }
      throw error;
    }
  },

  async update(idempotencyKey: string, patch: Record<string, unknown>) {
    await AssistantJob.updateOne({ idempotencyKey }, { $set: patch });
  },
};

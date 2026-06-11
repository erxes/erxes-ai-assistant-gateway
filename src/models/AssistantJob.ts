import { model, Schema, type InferSchemaType } from "mongoose";

export const assistantJobStatuses = [
  "started",
  "running",
  "verifying",
  "ready",
  "failed",
] as const;

export type AssistantJobStatus = (typeof assistantJobStatuses)[number];

const assistantJobSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true },
    assistantId: { type: String, required: true, trim: true },
    openclawUrl: { type: String, required: true, trim: true },
    guildId: { type: String, required: true, trim: true },
    channelId: { type: String, required: true, trim: true },
    threadId: { type: String, trim: true },
    messageId: { type: String, required: true, trim: true },
    conversationKey: { type: String, required: true, trim: true },
    opType: { type: String, required: true, trim: true },
    operation: { type: String, trim: true },
    idempotencyKey: { type: String, required: true, unique: true },
    runtimeJobId: { type: String, trim: true },
    status: {
      type: String,
      enum: assistantJobStatuses,
      required: true,
      default: "started",
    },
    error: { type: String, trim: true },
  },
  { timestamps: true },
);

assistantJobSchema.index({ status: 1, updatedAt: -1 });

export type AssistantJobDocument = InferSchemaType<typeof assistantJobSchema>;

export const AssistantJob = model("AssistantJob", assistantJobSchema);

import { model, Schema, type InferSchemaType } from "mongoose";

export const discordAssistantResponseModes = [
  "slash_only",
  "all_messages",
] as const;

export type DiscordAssistantResponseMode =
  (typeof discordAssistantResponseModes)[number];

const discordAssistantBindingSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true },
    assistantId: { type: String, required: true, trim: true },
    assistantName: { type: String, trim: true },
    discordGuildId: { type: String, required: true, trim: true },
    discordChannelId: { type: String, required: true, trim: true },
    openclawUrl: { type: String, required: true, trim: true },
    enabled: { type: Boolean, required: true, default: true },
    responseMode: {
      type: String,
      enum: discordAssistantResponseModes,
      required: true,
      default: "slash_only",
    },
  },
  { timestamps: true },
);

discordAssistantBindingSchema.index(
  { discordGuildId: 1, discordChannelId: 1 },
  { unique: true, partialFilterExpression: { enabled: true } },
);

discordAssistantBindingSchema.index({
  tenantId: 1,
  assistantId: 1,
  discordGuildId: 1,
});

discordAssistantBindingSchema.index({ openclawUrl: 1 });

export type DiscordAssistantBindingDocument = InferSchemaType<
  typeof discordAssistantBindingSchema
>;

export const DiscordAssistantBinding = model(
  "DiscordAssistantBinding",
  discordAssistantBindingSchema,
);

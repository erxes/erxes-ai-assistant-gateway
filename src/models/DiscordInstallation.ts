import { model, Schema, type InferSchemaType } from "mongoose";

const discordInstallationSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true },
    assistantId: { type: String, trim: true },
    discordGuildId: { type: String, required: true, trim: true },
    discordGuildName: { type: String, trim: true },
    installedByDiscordUserId: { type: String, trim: true },
    installedByErxesUserId: { type: String, trim: true },
    status: {
      type: String,
      enum: ["connected", "disabled", "revoked"],
      required: true,
      default: "connected",
    },
    scopes: [{ type: String }],
    permissions: { type: String, trim: true },
  },
  { timestamps: true },
);

discordInstallationSchema.index(
  { tenantId: 1, discordGuildId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "connected" },
  },
);

export type DiscordInstallationDocument = InferSchemaType<
  typeof discordInstallationSchema
>;

export const DiscordInstallation = model(
  "DiscordInstallation",
  discordInstallationSchema,
);

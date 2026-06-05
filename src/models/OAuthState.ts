import { model, Schema, type InferSchemaType } from "mongoose";

const oauthStateSchema = new Schema(
  {
    state: { type: String, required: true, unique: true, trim: true },
    tenantId: { type: String, required: true, trim: true },
    assistantId: { type: String, trim: true },
    erxesUserId: { type: String, trim: true },
    returnUrl: { type: String, trim: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

oauthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type OAuthStateDocument = InferSchemaType<typeof oauthStateSchema>;

export const OAuthState = model("OAuthState", oauthStateSchema);

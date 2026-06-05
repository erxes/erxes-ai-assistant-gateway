import { randomBytes } from "node:crypto";

export const createSecureState = () => randomBytes(32).toString("base64url");


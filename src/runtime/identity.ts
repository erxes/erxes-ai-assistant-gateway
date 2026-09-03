import crypto from "node:crypto";

export const assistantRuntimeKinds = ["openclaw", "hermes"] as const;
export type AssistantRuntimeKind = (typeof assistantRuntimeKinds)[number];

export type RuntimeIdentity = {
  tenantId: string;
  assistantId: string;
  runtimeKind?: AssistantRuntimeKind;
};

const identityPayload = ({
  timestamp,
  method,
  path,
  runtimeKind,
  tenantId,
  assistantId,
}: RuntimeIdentity & {
  timestamp: string;
  method: string;
  path: string;
}) =>
  [
    timestamp,
    method.toUpperCase(),
    path,
    runtimeKind || "openclaw",
    tenantId,
    assistantId,
  ].join("\n");

export const buildRuntimeIdentityHeaders = ({
  identity,
  method,
  path,
  sharedSecret,
  timestamp = Date.now(),
}: {
  identity: RuntimeIdentity;
  method: string;
  path: string;
  sharedSecret: string;
  timestamp?: number;
}): Record<string, string> => {
  const timestampValue = String(timestamp);
  const runtimeKind = identity.runtimeKind || "openclaw";
  const headers: Record<string, string> = {
    "x-erxes-tenant-id": identity.tenantId,
    "x-erxes-assistant-id": identity.assistantId,
    "x-erxes-runtime-kind": runtimeKind,
    "x-erxes-runtime-timestamp": timestampValue,
  };

  if (!sharedSecret) {
    return headers;
  }

  headers["x-erxes-runtime-signature"] = crypto
    .createHmac("sha256", sharedSecret)
    .update(
      identityPayload({
        ...identity,
        runtimeKind,
        timestamp: timestampValue,
        method,
        path,
      }),
    )
    .digest("hex");

  return headers;
};

export const verifyRuntimeIdentitySignature = ({
  identity,
  method,
  path,
  sharedSecret,
  timestamp,
  signature,
  now = Date.now(),
  maxAgeMs = 60_000,
}: {
  identity: RuntimeIdentity;
  method: string;
  path: string;
  sharedSecret: string;
  timestamp: string;
  signature: string;
  now?: number;
  maxAgeMs?: number;
}) => {
  const timestampNumber = Number(timestamp);

  if (
    !sharedSecret ||
    !signature ||
    !Number.isFinite(timestampNumber) ||
    Math.abs(now - timestampNumber) > maxAgeMs
  ) {
    return false;
  }

  const expected = buildRuntimeIdentityHeaders({
    identity,
    method,
    path,
    sharedSecret,
    timestamp: timestampNumber,
  })["x-erxes-runtime-signature"];
  const expectedBuffer = Buffer.from(expected || "", "hex");
  const providedBuffer = Buffer.from(signature, "hex");

  return (
    expectedBuffer.length > 0 &&
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  );
};

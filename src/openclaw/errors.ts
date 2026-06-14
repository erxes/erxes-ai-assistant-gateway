export const RUNTIME_ERROR_CATEGORIES = [
  "runtime_unreachable",
  "runtime_timeout",
  "provider_timeout",
  "plugin_validation_failed",
  "plugin_quarantined",
  "openclaw_config_invalid",
  "tool_execution_failed",
  "job_failed",
  "invalid_request",
  "unknown",
] as const;

export type RuntimeErrorCategory = (typeof RUNTIME_ERROR_CATEGORIES)[number];

const isCategory = (value: unknown): value is RuntimeErrorCategory =>
  typeof value === "string" &&
  (RUNTIME_ERROR_CATEGORIES as readonly string[]).includes(value);

export class OpenClawRuntimeError extends Error {
  category: RuntimeErrorCategory;
  status?: number;
  requestId?: string;
  pluginId?: string;
  safeMessage?: string;

  constructor(
    message: string,
    options: {
      category: RuntimeErrorCategory;
      status?: number;
      requestId?: string;
      pluginId?: string;
      safeMessage?: string;
    },
  ) {
    super(message);
    this.name = "OpenClawRuntimeError";
    this.category = options.category;
    this.status = options.status;
    this.requestId = options.requestId;
    this.pluginId = options.pluginId;
    this.safeMessage = options.safeMessage;
  }
}

type RuntimeErrorBody = {
  error?: unknown;
  category?: unknown;
  requestId?: unknown;
  pluginId?: unknown;
  safeMessage?: unknown;
};

const categoryFromStatus = (status: number): RuntimeErrorCategory => {
  if (status === 503 || status === 502 || status === 404) {
    return "runtime_unreachable";
  }
  if (status === 504 || status === 408) return "provider_timeout";
  return "unknown";
};

/**
 * Build a structured error from a non-OK adapter HTTP response. Prefers the
 * adapter's own category/safeMessage fields; falls back to status inference.
 */
export const runtimeErrorFromResponse = (
  status: number,
  bodyText: string,
): OpenClawRuntimeError => {
  let body: RuntimeErrorBody = {};

  try {
    body = JSON.parse(bodyText) as RuntimeErrorBody;
  } catch {
    // Non-JSON body (e.g. proxy error page); classify from status alone.
  }

  const category = isCategory(body.category)
    ? body.category
    : categoryFromStatus(status);
  const detail =
    typeof body.error === "string" && body.error.trim()
      ? body.error.trim().replace(/\s+/g, " ").slice(0, 160)
      : `status ${status}`;

  return new OpenClawRuntimeError(
    `OpenClaw request failed with status ${status}: ${detail}`,
    {
      category,
      status,
      requestId:
        typeof body.requestId === "string" ? body.requestId : undefined,
      pluginId: typeof body.pluginId === "string" ? body.pluginId : undefined,
      safeMessage:
        typeof body.safeMessage === "string" ? body.safeMessage : undefined,
    },
  );
};

/**
 * Wrap a network/abort failure from fetch itself (the adapter never
 * responded) into a structured error.
 */
export const runtimeErrorFromNetworkFailure = (
  error: unknown,
): OpenClawRuntimeError => {
  if (error instanceof OpenClawRuntimeError) return error;

  const message = error instanceof Error ? error.message : String(error);

  if (/abort|timed? ?out/i.test(message)) {
    return new OpenClawRuntimeError(message, { category: "runtime_timeout" });
  }

  return new OpenClawRuntimeError(message || "fetch failed", {
    category: "runtime_unreachable",
  });
};

export const categorizeError = (error: unknown): RuntimeErrorCategory => {
  if (error instanceof OpenClawRuntimeError) return error.category;
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|timed? ?out/i.test(message)) return "runtime_timeout";
  if (/fetch failed|ECONNREFUSED|ECONNRESET|EAI_AGAIN/i.test(message)) {
    return "runtime_unreachable";
  }
  return "unknown";
};

const CATEGORY_MESSAGES: Record<RuntimeErrorCategory, string> = {
  runtime_unreachable:
    "The assistant runtime is currently unreachable. I could not complete the operation. Please try again shortly.",
  runtime_timeout:
    "The assistant runtime took too long to respond. Please retry in a moment.",
  provider_timeout:
    "The model provider timed out while processing this request. Please retry; no changes were applied.",
  plugin_validation_failed:
    "A plugin is installed but could not be loaded into the runtime, so it was kept unloaded. The assistant and all other tools keep working; the plugin can be retried any time.",
  plugin_quarantined:
    "A plugin is installed but could not be loaded into the runtime, so it was kept unloaded. The assistant and all other tools keep working; the plugin can be retried any time.",
  openclaw_config_invalid:
    "The assistant configuration failed validation. The change was rolled back; other features are still available.",
  tool_execution_failed:
    "A tool or plugin failed while processing this request. Other assistant features are still available. Please retry.",
  job_failed: "The operation failed before completing. Please retry.",
  invalid_request:
    "I couldn't process that request format. Please rephrase and try again.",
  unknown: "I hit an unexpected error while processing this request.",
};

/**
 * User-facing Discord message for a runtime failure. Never the bare generic
 * fallback: known categories get specific guidance, unknown errors carry a
 * short reference id that matches the gateway logs.
 */
export const friendlyRuntimeErrorMessage = (
  error: unknown,
  referenceId: string,
): string => {
  const category = categorizeError(error);

  if (error instanceof OpenClawRuntimeError && error.safeMessage) {
    return `${error.safeMessage} (ref ${referenceId})`;
  }

  let message = CATEGORY_MESSAGES[category];

  if (
    error instanceof OpenClawRuntimeError &&
    error.pluginId &&
    (category === "plugin_quarantined" || category === "plugin_validation_failed")
  ) {
    message = `The plugin ${error.pluginId} is installed, but it could not be loaded into the runtime, so I kept it unloaded and the assistant keeps working. I can retry it once the plugin is updated.`;
  }

  return `${message} (ref ${referenceId})`;
};

/** Short correlation id derived from the Discord message id. */
export const buildReferenceId = (messageId: string): string =>
  messageId.slice(-8) || "unknown";

// Layered secret/config exfiltration protection shared across the Discord
// gateway flow. All checks are deterministic and content-based; none of these
// functions log or echo the data they inspect.

export const SECRET_REFUSAL_MESSAGE =
  "I can't share runtime config, auth tokens, or secret files.";

export type DetectionResult = {
  blocked: boolean;
  // Coarse category only — safe to log. Never includes the matched value.
  category?:
    | "openclaw-config"
    | "dotenv"
    | "ssh-key"
    | "private-key-file"
    | "secret-name"
    | "system-path"
    | "config-disclosure";
};

export type ScanResult = {
  // Coarse reasons only (e.g. "private-key-block"); never the matched value.
  hasSecret: boolean;
  reasons: string[];
  // "hard" => block the whole response; "soft" => safe to redact in place.
  severity: "none" | "soft" | "hard";
};

export type GuardResult = {
  action: "allow" | "redact" | "block";
  text: string;
  reason?: string;
};

// ── Path normalization ──────────────────────────────────────────────────────

const decodeMaybe = (value: string): string => {
  let out = value;
  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(out);
      if (decoded === out) break;
      out = decoded;
    } catch {
      break;
    }
  }
  return out;
};

// Normalize quoting, backticks, URL-encoding, and collapse whitespace so
// obfuscated paths still match.
export const normalizeForPathCheck = (input: string): string =>
  decodeMaybe(String(input ?? ""))
    .replace(/[`'"]/g, "")
    .replace(/\\(?=[/.~])/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();

const PROTECTED_PATH_PATTERNS: Array<{ re: RegExp; category: DetectionResult["category"] }> = [
  { re: /\/?root\/\.openclaw\//, category: "openclaw-config" },
  { re: /\.openclaw\/[^\s]*\b(openclaw\.json|auth|config|profile|credential)/, category: "openclaw-config" },
  { re: /\bopenclaw\.json\b/, category: "openclaw-config" },
  { re: /auth-profiles?\.json/, category: "openclaw-config" },
  { re: /(^|[\s/])\.env(\.[a-z0-9_-]+)?\b/, category: "dotenv" },
  { re: /(~|\/root|\/home\/[^/\s]+)\/\.ssh\b/, category: "ssh-key" },
  { re: /\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b/, category: "ssh-key" },
  { re: /\.(pem|key|p12|pfx)\b/, category: "private-key-file" },
  { re: /\/proc\/self\/environ\b/, category: "system-path" },
  { re: /(^|[\s])\/(etc|var\/lib)\//, category: "system-path" },
];

const SECRET_NAME_RE =
  /\b(tokens?|secrets?|credentials?|api[-_]?keys?|apikeys?|passwords?|auth[-_]?profiles?)\b/;

// Verbs that indicate an attempt to disclose file/config content.
const DISCLOSE_VERB_RE =
  /\b(send|show|share|read|cat|print|display|upload|attach|reveal|dump|copy|export|zip|tar|encode|base64|screenshot|paste|leak|give|fetch|download|summari[sz]e|open|disclose)\b/;

const CONFIG_DISCLOSURE_RE =
  /\b(your|the|runtime|gateway)\b[^.\n]{0,40}\b(config(uration)?|auth\s*profile|auth\s*token|credentials?|secret|\.env|environment\s*variables?)\b/;

export const isProtectedSourcePath = (input: string): boolean => {
  const normalized = normalizeForPathCheck(input);
  if (!normalized) return false;
  return PROTECTED_PATH_PATTERNS.some(({ re }) => re.test(normalized));
};

const protectedPathCategory = (
  input: string,
): DetectionResult["category"] | undefined => {
  const normalized = normalizeForPathCheck(input);
  for (const { re, category } of PROTECTED_PATH_PATTERNS) {
    if (re.test(normalized)) return category;
  }
  return undefined;
};

// Layer 1 — inbound request denylist.
export const detectProtectedFileRequest = (message: string): DetectionResult => {
  const normalized = normalizeForPathCheck(message);
  if (!normalized) return { blocked: false };

  const pathCategory = protectedPathCategory(message);
  if (pathCategory) {
    return { blocked: true, category: pathCategory };
  }

  const wantsDisclosure = DISCLOSE_VERB_RE.test(normalized);

  // "send your auth profile", "summarize your config", "show the gateway token"
  if (wantsDisclosure && CONFIG_DISCLOSURE_RE.test(normalized)) {
    return { blocked: true, category: "config-disclosure" };
  }

  // Disclosure verb aimed at a secret-named file ("upload the credentials file").
  if (
    wantsDisclosure &&
    SECRET_NAME_RE.test(normalized) &&
    /\b(file|files|json|yaml|yml|profile|env)\b/.test(normalized)
  ) {
    return { blocked: true, category: "secret-name" };
  }

  return { blocked: false };
};

// ── Content scanning ────────────────────────────────────────────────────────

const HARD_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /-----BEGIN (?:OPENSSH |RSA |EC |DSA |PGP )?PRIVATE KEY-----/, reason: "private-key-block" },
  { re: /mongodb(?:\+srv)?:\/\/[^\s"']+/i, reason: "mongodb-uri" },
  { re: /\bsk-[a-zA-Z0-9_-]{16,}\b/, reason: "openai-style-key" },
  { re: /\bxox[baprs]-[a-zA-Z0-9-]{8,}\b/, reason: "slack-token" },
  { re: /\bBearer\s+[a-zA-Z0-9._\-]{16,}\b/, reason: "bearer-token" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/, reason: "github-token" },
  { re: /["']?gateway["']?\s*[:.]\s*["']?auth["']?\s*[:.]\s*["']?token/i, reason: "gateway-auth-token" },
  // Long hex token: require both a letter and a digit so repeated chars and
  // natural words ("aaaa…", "deadbeef" prose) don't false-positive.
  { re: /\b(?=[a-f0-9]*[a-f])(?=[a-f0-9]*[0-9])[a-f0-9]{48,}\b/i, reason: "long-hex-token" },
  { re: /x-erxes-managed-deployer-secret/i, reason: "deployer-secret-header" },
  { re: /x-erxes-ai-assistant-secret/i, reason: "runtime-secret-header" },
];

const SOFT_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(?=[a-f0-9]*[a-f])(?=[a-f0-9]*[0-9])[a-f0-9]{32,47}\b/i, reason: "hex-token" },
  { re: /\b(authorization|x-api-key)\s*:/i, reason: "auth-header" },
  { re: /["']?(api[_-]?key|apikey|secret|password|credential|private[_-]?key|auth)["']?\s*[:=]\s*["']?[^\s"',}]{6,}/i, reason: "sensitive-key-value" },
];

export const scanTextForSecrets = (text: string): ScanResult => {
  const value = String(text ?? "");
  const reasons = new Set<string>();
  let severity: ScanResult["severity"] = "none";

  for (const { re, reason } of HARD_PATTERNS) {
    if (re.test(value)) {
      reasons.add(reason);
      severity = "hard";
    }
  }

  if (severity !== "hard") {
    for (const { re, reason } of SOFT_PATTERNS) {
      if (re.test(value)) {
        reasons.add(reason);
        severity = "soft";
      }
    }
  } else {
    for (const { re, reason } of SOFT_PATTERNS) {
      if (re.test(value)) reasons.add(reason);
    }
  }

  return {
    hasSecret: reasons.size > 0,
    reasons: [...reasons],
    severity,
  };
};

const SENSITIVE_JSON_KEY_RE =
  /^(token|secret|apikey|api_key|authorization|password|credential|credentials|auth|privatekey|private_key)$/i;

export const scanJsonForSensitiveKeys = (value: unknown): ScanResult => {
  const reasons = new Set<string>();

  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (SENSITIVE_JSON_KEY_RE.test(key)) {
        const hasValue =
          (typeof child === "string" && child.trim().length > 0) ||
          (child !== null && typeof child === "object" && Object.keys(child).length > 0);
        if (hasValue) reasons.add(`sensitive-key:${key.toLowerCase()}`);
      }
      walk(child);
    }
  };

  walk(value);
  return {
    hasSecret: reasons.size > 0,
    reasons: [...reasons],
    severity: reasons.size > 0 ? "hard" : "none",
  };
};

const REDACT_PATTERNS: RegExp[] = [
  /-----BEGIN (?:OPENSSH |RSA |EC |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH |RSA |EC |DSA |PGP )?PRIVATE KEY-----/g,
  /mongodb(?:\+srv)?:\/\/[^\s"']+/gi,
  /\bsk-[a-zA-Z0-9_-]{16,}\b/g,
  /\bxox[baprs]-[a-zA-Z0-9-]{8,}\b/g,
  /\bBearer\s+[a-zA-Z0-9._\-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\b(?=[a-f0-9]*[a-f])(?=[a-f0-9]*[0-9])[a-f0-9]{32,}\b/gi,
  /((?:api[_-]?key|apikey|secret|password|credential|private[_-]?key|token|auth)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
];

export const redactSecrets = (text: string): string => {
  let out = String(text ?? "");
  for (const re of REDACT_PATTERNS) {
    out = out.replace(re, (match, prefix) =>
      typeof prefix === "string" ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return out;
};

// Layer 3 — outbound text filtering.
export const guardOutboundText = (text: string): GuardResult => {
  const scan = scanTextForSecrets(text);
  if (!scan.hasSecret) {
    return { action: "allow", text: String(text ?? "") };
  }
  // Hard secrets (config/auth/keys/URIs) => block the whole response.
  if (scan.severity === "hard") {
    return {
      action: "block",
      text: SECRET_REFUSAL_MESSAGE,
      reason: scan.reasons.join(","),
    };
  }
  // Otherwise redact in place.
  return {
    action: "redact",
    text: redactSecrets(text),
    reason: scan.reasons.join(","),
  };
};

// Layer 2 — generated output file scanning.
export const guardOutboundFileBytes = (
  bytes: Buffer | Uint8Array,
  filename?: string,
): GuardResult => {
  if (filename && isProtectedSourcePath(filename)) {
    return { action: "block", text: SECRET_REFUSAL_MESSAGE, reason: "protected-filename" };
  }
  // Inspect as UTF-8 text; binary files (images/pdf) won't match text patterns.
  const text = Buffer.from(bytes).toString("utf8");
  const textScan = scanTextForSecrets(text);

  let jsonScan: ScanResult = { hasSecret: false, reasons: [], severity: "none" };
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      jsonScan = scanJsonForSensitiveKeys(JSON.parse(trimmed));
    } catch {
      // not valid JSON — text scan already covers it
    }
  }

  if (textScan.severity === "hard" || jsonScan.hasSecret) {
    return {
      action: "block",
      text: SECRET_REFUSAL_MESSAGE,
      reason: [...textScan.reasons, ...jsonScan.reasons].join(","),
    };
  }
  if (textScan.hasSecret) {
    // Soft hits in a file are treated as block too — files are not redacted.
    return {
      action: "block",
      text: SECRET_REFUSAL_MESSAGE,
      reason: textScan.reasons.join(","),
    };
  }
  return { action: "allow", text: "" };
};

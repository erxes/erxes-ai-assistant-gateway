export type LongRunningOperationType =
  | "install"
  | "enable-plugin"
  | "create-agent"
  | "browser-workflow"
  | "cron-setup"
  | "file-processing";

const LONG_OP_PATTERNS: Array<{
  opType: LongRunningOperationType;
  pattern: RegExp;
}> = [
  { opType: "install", pattern: /\b(npm|pnpm|yarn|pip)\s+install\b/i },
  { opType: "install", pattern: /\b(?:re)?install(?:ing)?\b/i },
  { opType: "enable-plugin", pattern: /\benable\b[\s\S]{0,80}\bplugins?\b/i },
  {
    opType: "create-agent",
    pattern: /\b(create|add|spawn|set\s?up)\b[\s\S]{0,80}\b(sub-?agents?|agents?)\b/i,
  },
  {
    opType: "browser-workflow",
    pattern:
      /\bbrowser\b[\s\S]{0,80}\b(workflow|automation|navigate|scrape|screenshot)\b/i,
  },
  {
    opType: "browser-workflow",
    pattern: /\b(scrape|screenshot|crawl)\b[\s\S]{0,80}\b(site|page|url|website)\b/i,
  },
  {
    opType: "cron-setup",
    pattern: /\b(cron|schedule[ds]?\s+(a\s+)?(job|task)|recurring\s+(job|task))\b/i,
  },
  {
    opType: "file-processing",
    pattern: /\b(process|analyze|convert|transform)\b[\s\S]{0,80}\b(large|big|huge)\b[\s\S]{0,40}\bfiles?\b/i,
  },
];

export const detectLongRunningOperation = (
  text: string,
): LongRunningOperationType | null => {
  const trimmed = text.trim();

  if (!trimmed) {
    return null;
  }

  for (const { opType, pattern } of LONG_OP_PATTERNS) {
    if (pattern.test(trimmed)) {
      return opType;
    }
  }

  return null;
};

export const summarizeOperation = (text: string, max = 140): string => {
  const clean = text
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

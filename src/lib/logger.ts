type LogMeta = Record<string, unknown>;

const write = (level: "info" | "warn" | "error", message: string, meta?: LogMeta) => {
  const payload = {
    level,
    message,
    service: "erxes-ai-assistant-gateway",
    time: new Date().toISOString(),
    ...(meta ? { meta } : {}),
  };

  const line = JSON.stringify(payload);

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
};

export const logger = {
  info: (message: string, meta?: LogMeta) => write("info", message, meta),
  warn: (message: string, meta?: LogMeta) => write("warn", message, meta),
  error: (message: string, meta?: LogMeta) => write("error", message, meta),
};


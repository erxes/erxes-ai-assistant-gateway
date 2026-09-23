import { env } from "../config/env.js";

// Hibernation wake-up. When a runtime is unreachable, it is very likely a
// hibernated (scaled-to-0) assistant: ask the deployer to wake it, then let
// the caller's existing retry schedule (5/15/30/60/90s ≈ 3.5min of patience)
// deliver the original request once the pod is serving again (~35-50s with the
// warm-boot fast path). Fire-and-forget: a wake failure must never break the
// retry loop — a genuinely-down runtime fails exactly as it did before.

// Per-runtime cooldown so the five retries of one request (and concurrent
// requests to the same assistant) produce one wake call, not a stampede.
const WAKE_COOLDOWN_MS = 60_000;
const lastWakeAt = new Map<string, number>();

/** "https://assistant-x.assistant.erxes.io" -> "assistant-x" (the serverName). */
export const serverNameFromRuntimeUrl = (openclawUrl: string): string | null => {
  try {
    const host = new URL(openclawUrl).hostname;
    const first = host.split(".")[0];
    return first && first.startsWith("assistant-") ? first : null;
  } catch {
    return null;
  }
};

export const requestRuntimeWake = (openclawUrl: string): void => {
  if (!env.MANAGED_DEPLOYER_SECRET) return; // feature off until env is set

  const serverName = serverNameFromRuntimeUrl(openclawUrl);
  if (!serverName) return;

  const now = Date.now();
  const last = lastWakeAt.get(serverName) ?? 0;
  if (now - last < WAKE_COOLDOWN_MS) return;
  lastWakeAt.set(serverName, now);

  fetch(`${env.MANAGED_DEPLOYER_URL}/agents/${serverName}/wake`, {
    method: "POST",
    headers: { "x-erxes-managed-deployer-secret": env.MANAGED_DEPLOYER_SECRET },
    signal: AbortSignal.timeout(5_000),
  })
    .then(async r => {
      const body = await r.text().catch(() => "");
      console.log(
        `[wake] ${serverName} -> ${r.status} ${body.slice(0, 120)}`,
      );
    })
    .catch(err => {
      console.warn(`[wake] ${serverName} failed: ${err?.message ?? err}`);
    });
};

import type { HealthState, ServiceHealth } from "./types.ts";

export const HEALTH_CHECK_INTERVAL_MS = 30_000;
export const HEALTH_CHECK_TIMEOUT_MS = 5_000;

export function normalizeServiceUrl(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `http://${trimmed}`;
}

export function evaluateStatus(code: number): HealthState {
  if (code >= 200 && code < 400) {
    return "online";
  }

  return "offline";
}

export function createInitialHealth(): ServiceHealth {
  return {
    state: "unknown",
    lastCheckedAt: null,
    errorCode: null,
    errorDetails: null,
  };
}

export function relativeTime(timestamp: number | null, now = Date.now()): string {
  if (!timestamp) {
    return "never";
  }

  const diffMs = Math.max(0, now - timestamp);
  const seconds = Math.floor(diffMs / 1000);

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

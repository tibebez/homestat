import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Config, GlobalSettings } from "./types.ts";

export const CONFIG_PATH = join(homedir(), ".homestat", "config.json");

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  autoRefreshEnabled: true,
  autoRefreshIntervalSec: 30,
  autoRefreshDockerDiscovery: false,
  refreshOnStart: true,
};

function assertConfig(data: unknown): asserts data is { services: unknown[]; settings?: unknown } {
  if (!data || typeof data !== "object") {
    throw new Error("Config must be an object.");
  }

  const services = (data as { services?: unknown }).services;
  if (!Array.isArray(services)) {
    throw new Error("Config must include a services array.");
  }

  for (const [index, service] of services.entries()) {
    if (!service || typeof service !== "object") {
      throw new Error(`Service at index ${index} must be an object.`);
    }

    const name = (service as { name?: unknown }).name;
    const url = (service as { url?: unknown }).url;
    if (typeof name !== "string" || !name.trim()) {
      throw new Error(`Service at index ${index} must have a non-empty name.`);
    }

    if (typeof url !== "string" || !url.trim()) {
      throw new Error(`Service '${name}' must have a non-empty url.`);
    }

    const containerId = (service as { containerId?: unknown }).containerId;
    if (containerId !== undefined && typeof containerId !== "string") {
      throw new Error(`Service '${name}' has an invalid containerId; expected a string.`);
    }

    const containerName = (service as { containerName?: unknown }).containerName;
    if (containerName !== undefined && typeof containerName !== "string") {
      throw new Error(`Service '${name}' has an invalid containerName; expected a string.`);
    }

    const source = (service as { source?: unknown }).source;
    if (source !== undefined && source !== "docker" && source !== "static") {
      throw new Error(`Service '${name}' has an invalid source; expected 'docker', 'static', or undefined.`);
    }

    const enabled = (service as { enabled?: unknown }).enabled;
    if (enabled !== undefined && typeof enabled !== "boolean") {
      throw new Error(`Service '${name}' has an invalid enabled flag; expected a boolean.`);
    }

    const group = (service as { group?: unknown }).group;
    if (group !== undefined && group !== null && typeof group !== "string") {
      throw new Error(`Service '${name}' has an invalid group; expected a string, null, or undefined.`);
    }

    const bookmarked = (service as { bookmarked?: unknown }).bookmarked;
    if (bookmarked !== undefined && typeof bookmarked !== "boolean") {
      throw new Error(`Service '${name}' has an invalid bookmarked flag; expected a boolean.`);
    }

    const bookmarkedAt = (service as { bookmarkedAt?: unknown }).bookmarkedAt;
    if (bookmarkedAt !== undefined && bookmarkedAt !== null && typeof bookmarkedAt !== "number") {
      throw new Error(`Service '${name}' has an invalid bookmarkedAt value; expected a number, null, or undefined.`);
    }
  }

  const settings = (data as { settings?: unknown }).settings;
  if (settings === undefined) {
    return;
  }

  if (!settings || typeof settings !== "object") {
    throw new Error("Config settings must be an object.");
  }

  const autoRefreshEnabled = (settings as { autoRefreshEnabled?: unknown }).autoRefreshEnabled;
  if (autoRefreshEnabled !== undefined && typeof autoRefreshEnabled !== "boolean") {
    throw new Error("Config settings has an invalid autoRefreshEnabled value; expected a boolean.");
  }

  const autoRefreshIntervalSec = (settings as { autoRefreshIntervalSec?: unknown }).autoRefreshIntervalSec;
  if (
    autoRefreshIntervalSec !== undefined &&
    (typeof autoRefreshIntervalSec !== "number" || !Number.isFinite(autoRefreshIntervalSec) || autoRefreshIntervalSec <= 0)
  ) {
    throw new Error("Config settings has an invalid autoRefreshIntervalSec value; expected a positive number.");
  }

  const autoRefreshDockerDiscovery = (settings as { autoRefreshDockerDiscovery?: unknown }).autoRefreshDockerDiscovery;
  if (autoRefreshDockerDiscovery !== undefined && typeof autoRefreshDockerDiscovery !== "boolean") {
    throw new Error("Config settings has an invalid autoRefreshDockerDiscovery value; expected a boolean.");
  }

  const refreshOnStart = (settings as { refreshOnStart?: unknown }).refreshOnStart;
  if (refreshOnStart !== undefined && typeof refreshOnStart !== "boolean") {
    throw new Error("Config settings has an invalid refreshOnStart value; expected a boolean.");
  }
}

function mergeGlobalSettings(settings?: Partial<GlobalSettings>): GlobalSettings {
  return {
    ...DEFAULT_GLOBAL_SETTINGS,
    ...settings,
    autoRefreshIntervalSec: Math.max(
      1,
      Math.round(settings?.autoRefreshIntervalSec ?? DEFAULT_GLOBAL_SETTINGS.autoRefreshIntervalSec),
    ),
  };
}

function normalizeConfig(config: { services: Config["services"]; settings?: Partial<GlobalSettings> }): Config {
  return {
    services: config.services,
    settings: mergeGlobalSettings(config.settings),
  };
}

export async function saveConfig(config: Config, path = CONFIG_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const normalized = normalizeConfig(config);
  await writeFile(path, JSON.stringify(normalized, null, 2), "utf8");
}

export async function loadConfig(path = CONFIG_PATH): Promise<Config> {
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      throw new Error(
        `Config not found at ${path}. Create it first (for example: mkdir -p ~/.homestat && cp ./config.example.json ~/.homestat/config.json).`,
      );
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Config at ${path} is not valid JSON.`);
  }

  assertConfig(parsed);
  return normalizeConfig(parsed as { services: Config["services"]; settings?: Partial<GlobalSettings> });
}

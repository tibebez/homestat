import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Config, GlobalSettings, Service, ServiceType } from "./types.ts";

export const CONFIG_PATH = join(homedir(), ".homestat", "config.json");
export const HOMESTAT_DIR = dirname(CONFIG_PATH);

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  autoRefreshEnabled: true,
  autoRefreshIntervalSec: 10,
  selectedAutoRefreshIntervalSec: 1,
  autoRefreshDockerDiscovery: false,
  refreshOnStart: true,
};

function isValidServiceType(value: unknown): value is ServiceType {
  return value === "manual" || value === "docker" || value === "widget";
}

function migrateService(data: unknown): Service {
  if (!data || typeof data !== "object") {
    throw new Error("Service must be an object.");
  }

  const record = data as Record<string, unknown>;

  const name = record.name;
  const url = record.url;
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("Service must have a non-empty name.");
  }
  if (typeof url !== "string" || !url.trim()) {
    throw new Error(`Service '${name}' must have a non-empty url.`);
  }

  // Migrate legacy 'source' field to 'type'
  let type: ServiceType = "manual";
  if (isValidServiceType(record.type)) {
    type = record.type;
  } else if (record.source === "docker") {
    type = "docker";
  } else if (record.source === "static") {
    type = "manual";
  }

  const base = {
    name: name.trim(),
    url: url.trim(),
    icon: record.icon !== undefined ? String(record.icon) : undefined,
    description: record.description !== undefined ? String(record.description) : undefined,
    group: record.group !== null && record.group !== undefined ? String(record.group) : (record.group === null ? null : undefined),
    type,
  };

  if (type === "docker") {
    const containerId = record.containerId;
    const containerName = record.containerName;
    if (typeof containerId !== "string" || !containerId.trim()) {
      throw new Error(`Docker service '${name}' must have a non-empty containerId.`);
    }
    if (typeof containerName !== "string" || !containerName.trim()) {
      throw new Error(`Docker service '${name}' must have a non-empty containerName.`);
    }
    return {
      ...base,
      type: "docker",
      containerId: containerId.trim(),
      containerName: containerName.trim(),
    };
  }

  if (type === "widget") {
    return { ...base, type: "widget" };
  }

  return { ...base, type: "manual" };
}

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

    const type = (service as { type?: unknown }).type;
    if (type !== undefined && !isValidServiceType(type)) {
      throw new Error(`Service '${name}' has an invalid type; expected 'manual', 'docker', or 'widget'.`);
    }

    const containerId = (service as { containerId?: unknown }).containerId;
    if (containerId !== undefined && typeof containerId !== "string") {
      throw new Error(`Service '${name}' has an invalid containerId; expected a string.`);
    }

    const containerName = (service as { containerName?: unknown }).containerName;
    if (containerName !== undefined && typeof containerName !== "string") {
      throw new Error(`Service '${name}' has an invalid containerName; expected a string.`);
    }

    const group = (service as { group?: unknown }).group;
    if (group !== undefined && group !== null && typeof group !== "string") {
      throw new Error(`Service '${name}' has an invalid group; expected a string, null, or undefined.`);
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

  const selectedAutoRefreshIntervalSec = (settings as { selectedAutoRefreshIntervalSec?: unknown }).selectedAutoRefreshIntervalSec;
  if (
    selectedAutoRefreshIntervalSec !== undefined &&
    (typeof selectedAutoRefreshIntervalSec !== "number" || !Number.isFinite(selectedAutoRefreshIntervalSec) || selectedAutoRefreshIntervalSec <= 0)
  ) {
    throw new Error("Config settings has an invalid selectedAutoRefreshIntervalSec value; expected a positive number.");
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
    selectedAutoRefreshIntervalSec: Math.max(
      1,
      Math.round(settings?.selectedAutoRefreshIntervalSec ?? DEFAULT_GLOBAL_SETTINGS.selectedAutoRefreshIntervalSec),
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

  const data = parsed as { services: unknown[]; settings?: unknown };
  const migratedServices = data.services.map(migrateService);

  return normalizeConfig({ services: migratedServices, settings: data.settings as Partial<GlobalSettings> | undefined });
}

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Config, Service } from "./types.ts";

export const CONFIG_PATH = join(homedir(), ".homestat", "config.json");

function assertConfig(data: unknown): asserts data is Config {
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
  }
}

export async function saveConfig(config: Config, path = CONFIG_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), "utf8");
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

  // Auto-migrate old "groups" format to flat "services" format
  if (
    parsed &&
    typeof parsed === "object" &&
    "groups" in parsed &&
    !("services" in parsed)
  ) {
    const old = parsed as { groups?: unknown };
    const groups = Array.isArray(old.groups) ? old.groups : [];
    const services: Service[] = [];

    for (const group of groups) {
      if (group && typeof group === "object" && "services" in group) {
        const groupServices = (group as { services?: unknown }).services;
        if (Array.isArray(groupServices)) {
          for (const svc of groupServices) {
            if (svc && typeof svc === "object") {
              services.push(svc as Service);
            }
          }
        }
      }
    }

    const migrated: Config = { services };
    await saveConfig(migrated, path);
    return migrated;
  }

  assertConfig(parsed);
  return parsed as Config;
}

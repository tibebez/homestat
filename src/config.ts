import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "./types.ts";

export const CONFIG_PATH = join(homedir(), ".homestat", "config.json");

function assertConfig(data: unknown): asserts data is Config {
  if (!data || typeof data !== "object") {
    throw new Error("Config must be an object.");
  }

  const groups = (data as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) {
    throw new Error("Config must include a groups array.");
  }

  for (const [groupIndex, group] of groups.entries()) {
    if (!group || typeof group !== "object") {
      throw new Error(`Group at index ${groupIndex} must be an object.`);
    }

    const groupName = (group as { name?: unknown }).name;
    if (typeof groupName !== "string" || !groupName.trim()) {
      throw new Error(`Group at index ${groupIndex} must include a non-empty name.`);
    }

    const services = (group as { services?: unknown }).services;
    if (!Array.isArray(services)) {
      throw new Error(`Group '${groupName}' must include a services array.`);
    }

    for (const [serviceIndex, service] of services.entries()) {
      if (!service || typeof service !== "object") {
        throw new Error(
          `Service at index ${serviceIndex} in group '${groupName}' must be an object.`,
        );
      }

      const name = (service as { name?: unknown }).name;
      const url = (service as { url?: unknown }).url;
      if (typeof name !== "string" || !name.trim()) {
        throw new Error(
          `Service at index ${serviceIndex} in group '${groupName}' must have a non-empty name.`,
        );
      }

      if (typeof url !== "string" || !url.trim()) {
        throw new Error(`Service '${name}' in group '${groupName}' must have a non-empty url.`);
      }
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

  assertConfig(parsed);
  return parsed;
}

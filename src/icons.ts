import { randomInt } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { HOMESTAT_DIR } from "./config.ts";

const DASHBOARD_ICON_BASE_URL = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg";
const ICONS_DIR = join(HOMESTAT_DIR, "icons");
const ICON_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const FALLBACK_ICON_PREFIX = "fallback-random";

function sanitizeIconName(name: string): string | null {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, "-");
  if (!ICON_NAME_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

function iconFilePath(iconName: string): string {
  return join(ICONS_DIR, `${basename(iconName)}.svg`);
}

async function iconFileExists(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return metadata.isFile();
  } catch {
    return false;
  }
}

async function writeFallbackIconsIfMissing(): Promise<string[]> {
  await mkdir(ICONS_DIR, { recursive: true });
  const names: string[] = [];

  for (let index = 0; index < 20; index++) {
    const name = `${FALLBACK_ICON_PREFIX}-${String(index + 1).padStart(2, "0")}`;
    names.push(name);
    const filePath = iconFilePath(name);
    const exists = await iconFileExists(filePath);
    if (exists) {
      continue;
    }

    const hue = randomInt(0, 360);
    const secondaryHue = (hue + randomInt(35, 90)) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" role="img" aria-label="${name}"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="hsl(${hue} 78% 56%)"/><stop offset="100%" stop-color="hsl(${secondaryHue} 72% 42%)"/></linearGradient></defs><rect width="96" height="96" rx="20" fill="url(#g)"/><circle cx="48" cy="36" r="14" fill="rgba(255,255,255,0.35)"/><rect x="24" y="56" width="48" height="14" rx="7" fill="rgba(255,255,255,0.28)"/></svg>`;
    await writeFile(filePath, svg, "utf8");
  }

  return names;
}

async function fetchIconSvg(iconName: string): Promise<string | null> {
  const response = await fetch(`${DASHBOARD_ICON_BASE_URL}/${iconName}.svg`);
  if (!response.ok) {
    return null;
  }

  const svg = await response.text();
  if (!svg.trim().startsWith("<svg")) {
    return null;
  }

  return svg;
}

async function saveIconSvg(iconName: string, svg: string): Promise<void> {
  await mkdir(ICONS_DIR, { recursive: true });
  await writeFile(iconFilePath(iconName), svg, "utf8");
}

export function getDisplayIconLabel(iconName: string | undefined): string {
  const normalized = sanitizeIconName(iconName ?? "");
  if (!normalized) {
    return "??";
  }

  const parts = normalized.split("-").filter(Boolean);
  if (parts.length === 0) {
    return "??";
  }

  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

export async function ensureIconCached(iconNameRaw: string): Promise<string> {
  const normalized = sanitizeIconName(iconNameRaw);
  if (!normalized) {
    const fallbackNames = await writeFallbackIconsIfMissing();
    return fallbackNames[randomInt(0, fallbackNames.length)];
  }

  const filePath = iconFilePath(normalized);
  const exists = await iconFileExists(filePath);
  if (exists) {
    return normalized;
  }

  try {
    const svg = await fetchIconSvg(normalized);
    if (svg) {
      await saveIconSvg(normalized, svg);
      return normalized;
    }
  } catch {
    // Ignore fetch errors and fallback to local generated icons.
  }

  const fallbackNames = await writeFallbackIconsIfMissing();
  return fallbackNames[randomInt(0, fallbackNames.length)];
}

export async function warmMissingIcons(icons: readonly string[]): Promise<void> {
  const pending = icons
    .map((icon) => sanitizeIconName(icon))
    .filter((icon): icon is string => Boolean(icon))
    .map(async (icon) => {
      const path = iconFilePath(icon);
      const exists = await iconFileExists(path);
      if (exists) {
        return;
      }

      try {
        const svg = await fetchIconSvg(icon);
        if (!svg) {
          return;
        }
        await saveIconSvg(icon, svg);
      } catch {
        // Best effort warmup only.
      }
    });

  await Promise.all(pending);
}

export async function readCachedIconSvg(iconNameRaw: string): Promise<string | null> {
  const normalized = sanitizeIconName(iconNameRaw);
  if (!normalized) {
    return null;
  }

  const path = iconFilePath(normalized);
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

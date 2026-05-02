import type { WidgetDefinition } from "./types.ts";

interface TautulliActivity {
  response?: {
    data?: {
      stream_count?: number;
      sessions?: unknown[];
    };
  };
}

interface TautulliLibrary {
  response?: {
    data?: Array<{
      section_name?: string;
      count?: number;
      section_type?: string;
    }>;
  };
}

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, Math.max(0, length - 1))}…`;
}

export const tautulliWidget: WidgetDefinition = {
  id: "tautulli",
  name: "Tautulli",
  description: "Plex media server stats from Tautulli.",
  icon: "🎬",
  fields: [
    {
      name: "apiKey",
      label: "API Key",
      type: "password",
      required: true,
      placeholder: "Tautulli API key",
    },
  ],
  async fetchData(config) {
    const url = config.url ?? "";
    const apiKey = config.apiKey ?? "";

    if (!url || !apiKey) {
      return { error: "URL and API Key are required." };
    }

    const base = url.replace(/\/$/, "");

    try {
      const [activityRes, librariesRes] = await Promise.all([
        fetch(`${base}/api/v2?apikey=${encodeURIComponent(apiKey)}&cmd=get_activity`, {
          signal: AbortSignal.timeout(10_000),
        }),
        fetch(`${base}/api/v2?apikey=${encodeURIComponent(apiKey)}&cmd=get_libraries`, {
          signal: AbortSignal.timeout(10_000),
        }),
      ]);

      const activity: TautulliActivity = activityRes.ok ? await activityRes.json() as TautulliActivity : {};
      const libraries: TautulliLibrary = librariesRes.ok ? await librariesRes.json() as TautulliLibrary : {};

      const streamCount = activity.response?.data?.stream_count ?? 0;
      const sessions = activity.response?.data?.sessions ?? [];

      const libs =
        libraries.response?.data?.map((lib) => ({
          name: lib.section_name ?? "Unknown",
          count: lib.count ?? 0,
          type: lib.section_type ?? "",
        })) ?? [];

      return {
        activeStreams: streamCount,
        sessions: sessions.length,
        libraries: libs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message };
    }
  },
  render(data, width) {
    const d = data as {
      activeStreams?: number;
      sessions?: number;
      libraries?: Array<{ name: string; count: number; type: string }>;
      error?: string;
    };

    if (d.error) {
      return ["Error:", truncate(d.error, Math.max(10, width - 4))];
    }

    const lines: string[] = [];
    lines.push("Tautulli");
    lines.push("");

    const active = d.activeStreams ?? 0;
    const total = d.sessions ?? 0;
    lines.push(`Active Streams: ${active}${total > active ? ` (${total} total sessions)` : ""}`);
    lines.push("");

    const libs = d.libraries ?? [];
    if (libs.length > 0) {
      lines.push("Libraries:");
      for (const lib of libs) {
        const countStr = lib.count.toLocaleString();
        lines.push(`  ${truncate(lib.name, Math.max(6, width - 10))}: ${countStr}`);
      }
    } else {
      lines.push("Libraries: none reported");
    }

    return lines;
  },
};

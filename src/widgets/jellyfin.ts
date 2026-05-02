import type { WidgetDefinition } from "./types.ts";

interface JellyfinCounts {
  MovieCount?: number;
  SeriesCount?: number;
  EpisodeCount?: number;
  ArtistCount?: number;
  SongCount?: number;
}

interface JellyfinSession {
  NowPlayingItem?: unknown;
  PlayState?: { IsPaused?: boolean };
}

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, Math.max(0, length - 1))}…`;
}

export const jellyfinWidget: WidgetDefinition = {
  id: "jellyfin",
  name: "Jellyfin",
  description: "Jellyfin media server stats.",
  icon: "🎬",
  fields: [
    {
      name: "apiKey",
      label: "API Key",
      type: "password",
      required: true,
      placeholder: "Jellyfin API key",
    },
  ],
  async fetchData(config) {
    const url = config.url ?? "";
    const apiKey = config.apiKey ?? "";

    if (!url || !apiKey) {
      return { error: "URL and API Key are required." };
    }

    const base = url.replace(/\/$/, "");
    const headers: Record<string, string> = {
      "X-Emby-Token": apiKey,
      Accept: "application/json",
    };

    try {
      const [sessionsRes, countsRes] = await Promise.all([
        fetch(`${base}/Sessions`, { headers, signal: AbortSignal.timeout(10_000) }),
        fetch(`${base}/Items/Counts`, { headers, signal: AbortSignal.timeout(10_000) }),
      ]);

      const sessions: JellyfinSession[] = sessionsRes.ok ? await sessionsRes.json() as JellyfinSession[] : [];
      const counts: JellyfinCounts = countsRes.ok ? await countsRes.json() as JellyfinCounts : {};

      const activeSessions = sessions.filter((s) => s.NowPlayingItem && !s.PlayState?.IsPaused);

      return {
        activeStreams: activeSessions.length,
        sessions: sessions.length,
        libraries: [
          { name: "Movies", count: counts.MovieCount ?? 0, type: "movie" },
          { name: "TV Shows", count: counts.SeriesCount ?? 0, type: "show" },
          { name: "Episodes", count: counts.EpisodeCount ?? 0, type: "episode" },
          { name: "Artists", count: counts.ArtistCount ?? 0, type: "artist" },
          { name: "Songs", count: counts.SongCount ?? 0, type: "song" },
        ].filter((l) => l.count > 0),
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
    lines.push("Jellyfin");
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

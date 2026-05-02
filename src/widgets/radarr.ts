import type { WidgetDefinition } from "./types.ts";

interface RadarrMovie {
  title?: string;
  monitored?: boolean;
  hasFile?: boolean;
}

interface RadarrQueue {
  totalRecords?: number;
  records?: unknown[];
}

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, Math.max(0, length - 1))}…`;
}

export const radarrWidget: WidgetDefinition = {
  id: "radarr",
  name: "Radarr",
  description: "Movie management stats from Radarr.",
  icon: "🎞",
  fields: [
    {
      name: "apiKey",
      label: "API Key",
      type: "password",
      required: true,
      placeholder: "Radarr API key",
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
      "X-Api-Key": apiKey,
      Accept: "application/json",
    };

    try {
      const [moviesRes, queueRes] = await Promise.all([
        fetch(`${base}/api/v3/movie`, { headers, signal: AbortSignal.timeout(10_000) }),
        fetch(`${base}/api/v3/queue`, { headers, signal: AbortSignal.timeout(10_000) }),
      ]);

      const movies: RadarrMovie[] = moviesRes.ok ? (await moviesRes.json() as RadarrMovie[]) : [];
      const queue: RadarrQueue = queueRes.ok ? (await queueRes.json() as RadarrQueue) : {};

      const totalMovies = movies.length;
      const monitoredMovies = movies.filter((m) => m.monitored).length;
      const missingMovies = movies.filter((m) => m.monitored && !m.hasFile).length;
      const queueCount = queue.totalRecords ?? queue.records?.length ?? 0;

      return {
        totalMovies,
        monitoredMovies,
        missingMovies,
        queueCount,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message };
    }
  },
  render(data, width) {
    const d = data as {
      totalMovies?: number;
      monitoredMovies?: number;
      missingMovies?: number;
      queueCount?: number;
      error?: string;
    };

    if (d.error) {
      return ["Error:", truncate(d.error, Math.max(10, width - 4))];
    }

    const lines: string[] = [];
    lines.push("Radarr");
    lines.push("");
    lines.push(`Movies: ${d.totalMovies ?? 0} (${d.monitoredMovies ?? 0} monitored)`);
    lines.push(`Missing: ${d.missingMovies ?? 0}`);
    lines.push(`Queue: ${d.queueCount ?? 0}`);

    return lines;
  },
};

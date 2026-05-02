import type { WidgetDefinition } from "./types.ts";

interface SonarrSeries {
  title?: string;
  monitored?: boolean;
  status?: string;
}

interface SonarrQueue {
  totalRecords?: number;
  records?: unknown[];
}

interface SonarrWanted {
  totalRecords?: number;
}

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, Math.max(0, length - 1))}…`;
}

export const sonarrWidget: WidgetDefinition = {
  id: "sonarr",
  name: "Sonarr",
  description: "TV show management stats from Sonarr.",
  icon: "📺",
  fields: [
    {
      name: "apiKey",
      label: "API Key",
      type: "password",
      required: true,
      placeholder: "Sonarr API key",
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
      const [seriesRes, queueRes, missingRes] = await Promise.all([
        fetch(`${base}/api/v3/series`, { headers, signal: AbortSignal.timeout(10_000) }),
        fetch(`${base}/api/v3/queue`, { headers, signal: AbortSignal.timeout(10_000) }),
        fetch(`${base}/api/v3/wanted/missing`, { headers, signal: AbortSignal.timeout(10_000) }),
      ]);

      const series: SonarrSeries[] = seriesRes.ok ? (await seriesRes.json() as SonarrSeries[]) : [];
      const queue: SonarrQueue = queueRes.ok ? (await queueRes.json() as SonarrQueue) : {};
      const missing: SonarrWanted = missingRes.ok ? (await missingRes.json() as SonarrWanted) : {};

      const totalSeries = series.length;
      const monitoredSeries = series.filter((s) => s.monitored).length;
      const queueCount = queue.totalRecords ?? queue.records?.length ?? 0;
      const missingCount = missing.totalRecords ?? 0;

      return {
        totalSeries,
        monitoredSeries,
        queueCount,
        missingCount,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message };
    }
  },
  render(data, width) {
    const d = data as {
      totalSeries?: number;
      monitoredSeries?: number;
      queueCount?: number;
      missingCount?: number;
      error?: string;
    };

    if (d.error) {
      return ["Error:", truncate(d.error, Math.max(10, width - 4))];
    }

    const lines: string[] = [];
    lines.push("Sonarr");
    lines.push("");
    lines.push(`Series: ${d.totalSeries ?? 0} (${d.monitoredSeries ?? 0} monitored)`);
    lines.push(`Missing: ${d.missingCount ?? 0}`);
    lines.push(`Queue: ${d.queueCount ?? 0}`);

    return lines;
  },
};

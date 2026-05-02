export type HealthState = "online" | "offline" | "unknown";

export interface Service {
  name: string;
  url: string;
  icon?: string;
  description?: string;
  containerId?: string;
  containerName?: string;
  source?: "docker" | "static";
  enabled?: boolean;
  group?: string | null;
  bookmarked?: boolean;
  bookmarkedAt?: number | null;
}

export interface GlobalSettings {
  autoRefreshEnabled: boolean;
  autoRefreshIntervalSec: number;
  autoRefreshDockerDiscovery: boolean;
  refreshOnStart: boolean;
}

export interface Config {
  services: Service[];
  settings: GlobalSettings;
}

export interface ServiceHealth {
  state: HealthState;
  lastCheckedAt: number | null;
  errorCode: string | null;
  errorDetails: string | null;
}

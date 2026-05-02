export type HealthState = "online" | "offline" | "unknown";
export type ServiceType = "manual" | "docker" | "widget";

export interface BaseService {
  name: string;
  url: string;
  icon?: string;
  description?: string;
  group?: string | null;
  type: ServiceType;
}

export interface ManualService extends BaseService {
  type: "manual";
}

export interface DockerService extends BaseService {
  type: "docker";
  containerId: string;
  containerName: string;
}

export interface WidgetService extends BaseService {
  type: "widget";
}

export type Service = ManualService | DockerService | WidgetService;

export interface GlobalSettings {
  autoRefreshEnabled: boolean;
  autoRefreshIntervalSec: number;
  selectedAutoRefreshIntervalSec: number;
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

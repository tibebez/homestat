export type HealthState = "online" | "offline" | "unknown";

export interface Service {
  name: string;
  url: string;
  icon?: string;
  description?: string;
  containerId?: string;
  containerName?: string;
}

export interface Config {
  services: Service[];
}

export interface ServiceHealth {
  state: HealthState;
  lastCheckedAt: number | null;
  errorCode: string | null;
  errorDetails: string | null;
}

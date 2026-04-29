export type HealthState = "online" | "offline" | "unknown";

export interface Service {
  name: string;
  url: string;
  icon?: string;
}

export interface Group {
  name: string;
  services: Service[];
}

export interface Config {
  groups: Group[];
}

export interface FlatService {
  groupName: string;
  service: Service;
}

export interface ServiceHealth {
  state: HealthState;
  lastCheckedAt: number | null;
  errorCode: string | null;
  errorDetails: string | null;
}

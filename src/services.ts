import type { Service } from "./types.ts";

export type ServiceListView =
  | { kind: "all" }
  | { kind: "group"; groupName: string };

function canonicalizeGroupName(value: string): string {
  return value.trim();
}

function isBlank(value: string): boolean {
  return canonicalizeGroupName(value).length === 0;
}

export function isUngroupedService(service: Service): boolean {
  if (service.group == null) {
    return true;
  }

  return isBlank(service.group);
}

export function getServiceGroupLabel(service: Service, placeholder = "Ungrouped"): string {
  if (isUngroupedService(service)) {
    return placeholder;
  }

  return canonicalizeGroupName(service.group!);
}

export function getAllServices(services: readonly Service[]): Service[] {
  return [...services];
}

export function getUngroupedServices(services: readonly Service[]): Service[] {
  return services.filter(isUngroupedService);
}

export function getDistinctGroupNames(services: readonly Service[]): string[] {
  const seen = new Set<string>();
  const groups: string[] = [];

  for (const service of services) {
    if (isUngroupedService(service)) {
      continue;
    }

    const groupName = canonicalizeGroupName(service.group!);
    if (seen.has(groupName)) {
      continue;
    }

    seen.add(groupName);
    groups.push(groupName);
  }

  return groups;
}

export function getServicesByGroup(services: readonly Service[], groupName: string): Service[] {
  const canonicalGroupName = canonicalizeGroupName(groupName);

  return services.filter((service) => {
    if (isUngroupedService(service)) {
      return false;
    }

    return canonicalizeGroupName(service.group!) === canonicalGroupName;
  });
}

export function getServicesForView(
  services: readonly Service[],
  view: ServiceListView,
): Service[] {
  if (view.kind === "group") {
    return getServicesByGroup(services, view.groupName);
  }

  return getAllServices(services);
}

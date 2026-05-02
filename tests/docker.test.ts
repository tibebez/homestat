import { expect, test } from "bun:test";
import {
  isLocalServiceUrl,
  mapDiscoveredContainersToServices,
  mergeStaticAndDockerServices,
  parseDockerStatsJsonLine,
  parseDockerStatsOutput,
} from "../src/index.ts";

test("detects local service URLs", () => {
  expect(isLocalServiceUrl("localhost:3000")).toBe(true);
  expect(isLocalServiceUrl("http://localhost:8080")).toBe(true);
  expect(isLocalServiceUrl("http://127.0.0.1:8080")).toBe(true);
  expect(isLocalServiceUrl("http://0.0.0.0:8080")).toBe(true);
});

test("detects non-local service URLs", () => {
  expect(isLocalServiceUrl("https://example.com")).toBe(false);
  expect(isLocalServiceUrl("http://192.168.1.10:3000")).toBe(false);
  expect(isLocalServiceUrl("not-a-url")).toBe(false);
});

test("parses docker stats json line into cpu/ram/disk fields", () => {
  const collectedAt = 123_456;
  const line = JSON.stringify({
    ID: "abc123",
    Name: "jellyfin",
    CPUPerc: "3.14%",
    MemUsage: "250MiB / 2GiB",
    MemPerc: "12.2%",
    NetIO: "100kB / 200kB",
    BlockIO: "10MB / 5MB",
    PIDs: "19",
  });

  const result = parseDockerStatsJsonLine(line, collectedAt);

  expect(result.ok).toBe(true);
  if (!result.ok) return;

  expect(result.data.containerId).toBe("abc123");
  expect(result.data.containerName).toBe("jellyfin");
  expect(result.data.cpuUsage).toBe("3.14%");
  expect(result.data.memoryUsage).toBe("250MiB / 2GiB");
  expect(result.data.diskUsage).toBe("10MB / 5MB");
  expect(result.data.memoryPercent).toBe("12.2%");
  expect(result.data.networkIO).toBe("100kB / 200kB");
  expect(result.data.pids).toBe("19");
  expect(result.data.collectedAt).toBe(collectedAt);
});

test("parses docker stats output with extra whitespace lines", () => {
  const output = `\n\n${JSON.stringify({
    ID: "id01",
    Name: "grafana",
    CPUPerc: "0.8%",
    MemUsage: "88MiB / 1GiB",
    BlockIO: "1MB / 2MB",
  })}\n`;

  const result = parseDockerStatsOutput(output, 999);
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  expect(result.data.containerName).toBe("grafana");
  expect(result.data.cpuUsage).toBe("0.8%");
  expect(result.data.memoryUsage).toBe("88MiB / 1GiB");
  expect(result.data.diskUsage).toBe("1MB / 2MB");
  expect(result.data.collectedAt).toBe(999);
});

test("returns parse error for malformed docker stats json", () => {
  const result = parseDockerStatsJsonLine("{not-json}");

  expect(result.ok).toBe(false);
  if (result.ok) return;

  expect(result.error.code).toBe("DOCKER_OUTPUT_PARSE_ERROR");
  expect(result.error.message).toContain("not valid JSON");
});

test("returns parse error when required docker stats fields are missing", () => {
  const line = JSON.stringify({
    ID: "abc123",
    Name: "missing-fields",
    CPUPerc: "1.0%",
  });

  const result = parseDockerStatsJsonLine(line);

  expect(result.ok).toBe(false);
  if (result.ok) return;

  expect(result.error.code).toBe("DOCKER_OUTPUT_PARSE_ERROR");
  expect(result.error.message).toContain("missing one or more expected fields");
});

test("returns parse error for empty docker stats output", () => {
  const result = parseDockerStatsOutput("\n\n  \n");

  expect(result.ok).toBe(false);
  if (result.ok) return;

  expect(result.error.code).toBe("DOCKER_OUTPUT_PARSE_ERROR");
  expect(result.error.message).toContain("returned empty output");
});

test("maps discovered docker containers using label overrides and localhost port fallback", () => {
  const services = mapDiscoveredContainersToServices([
    {
      id: "abc123",
      name: "jellyfin",
      labels: {
        "homestat.name": "Jellyfin",
        "homestat.icon": "jellyfin",
      },
      ports: "0.0.0.0:8096->8096/tcp",
    },
    {
      id: "def456",
      name: "grafana",
      labels: {
        "homestat.url": "https://grafana.local",
      },
      ports: "0.0.0.0:3000->3000/tcp",
    },
  ]);

  expect(services[0]).toMatchObject({
    source: "docker",
    containerId: "abc123",
    containerName: "jellyfin",
    name: "Jellyfin",
    url: "http://localhost:8096",
    icon: "jellyfin",
  });

  expect(services[1]).toMatchObject({
    source: "docker",
    containerId: "def456",
    containerName: "grafana",
    name: "grafana",
    url: "https://grafana.local",
    icon: "docker",
  });
});

test("merges static and discovered services, deduping by container id", () => {
  const merged = mergeStaticAndDockerServices(
    [
      { name: "Static Jellyfin", url: "http://localhost:8096", containerId: "abc123" },
      { name: "Plex", url: "http://localhost:32400" },
    ],
    [
      {
        source: "docker",
        name: "Jellyfin",
        url: "http://localhost:8096",
        icon: "docker",
        containerId: "abc123",
        containerName: "jellyfin",
      },
      {
        source: "docker",
        name: "Grafana",
        url: "http://localhost:3000",
        icon: "docker",
        containerId: "def456",
        containerName: "grafana",
      },
    ],
  );

  expect(merged.map((service) => service.name)).toEqual([
    "Static Jellyfin",
    "Plex",
    "Grafana",
  ]);
});

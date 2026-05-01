import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Service } from "./types.ts";

const execFileAsync = promisify(execFile);

const DOCKER_COMMAND_TIMEOUT_MS = 5_000;
const DOCKER_COMMAND_MAX_BUFFER = 1024 * 1024;

export type DockerErrorCode =
  | "DOCKER_NOT_INSTALLED"
  | "DOCKER_DAEMON_UNAVAILABLE"
  | "CONTAINER_NOT_FOUND"
  | "INVALID_SERVICE_URL"
  | "NON_LOCAL_SERVICE"
  | "DOCKER_COMMAND_FAILED"
  | "DOCKER_OUTPUT_PARSE_ERROR";

export interface DockerError {
  code: DockerErrorCode;
  message: string;
  details: string | null;
}

export type DockerResult<T> =
  | {
      ok: true;
      data: T;
      error: null;
    }
  | {
      ok: false;
      data: null;
      error: DockerError;
    };

export interface DockerContainerRef {
  id: string | null;
  name: string;
  source: "configured" | "port_lookup";
  port: number | null;
}

export interface DockerContainerStats {
  containerId: string;
  containerName: string;
  cpuUsage: string;
  memoryUsage: string;
  memoryPercent: string | null;
  diskUsage: string;
  diskSize: string | null;
  diskSizeBytes: number | null;
  networkIO: string | null;
  pids: string | null;
  collectedAt: number;
}

export interface DockerDiscoveredContainer {
  id: string;
  name: string;
  labels: Record<string, string>;
  ports: string;
}

export interface DockerDiscoveryService extends Service {
  source: "docker";
  containerId: string;
  containerName: string;
}

interface ParsedServiceUrl {
  hostname: string;
  port: number;
}

interface DockerCommandSuccess {
  stdout: string;
  stderr: string;
}

function success<T>(data: T): DockerResult<T> {
  return { ok: true, data, error: null };
}

function failure<T>(code: DockerErrorCode, message: string, details: string | null = null): DockerResult<T> {
  return {
    ok: false,
    data: null,
    error: {
      code,
      message,
      details,
    },
  };
}

function normalizeServiceUrl(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `http://${trimmed}`;
}

function parseServiceUrl(url: string): ParsedServiceUrl | null {
  const normalized = normalizeServiceUrl(url);

  try {
    const parsed = new URL(normalized);
    const protocol = parsed.protocol.toLowerCase();

    const port = parsed.port
      ? Number(parsed.port)
      : protocol === "https:"
        ? 443
        : protocol === "http:"
          ? 80
          : NaN;

    if (!Number.isInteger(port) || port <= 0) {
      return null;
    }

    return {
      hostname: parsed.hostname.toLowerCase(),
      port,
    };
  } catch {
    return null;
  }
}

function dockerDaemonUnavailableMessage(message: string): boolean {
  return (
    /Cannot connect to the Docker daemon/i.test(message) ||
    /Is the docker daemon running\?/i.test(message) ||
    /error during connect/i.test(message) ||
    /permission denied while trying to connect to the Docker daemon socket/i.test(message)
  );
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function extractStdStreams(error: unknown): { stdout: string; stderr: string } {
  if (typeof error !== "object" || error === null) {
    return { stdout: "", stderr: "" };
  }

  const stdout = "stdout" in error && typeof (error as { stdout?: unknown }).stdout === "string"
    ? ((error as { stdout: string }).stdout ?? "")
    : "";
  const stderr = "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string"
    ? ((error as { stderr: string }).stderr ?? "")
    : "";

  return { stdout, stderr };
}

async function runDocker(args: string[]): Promise<DockerResult<DockerCommandSuccess>> {
  try {
    const result = await execFileAsync("docker", args, {
      timeout: DOCKER_COMMAND_TIMEOUT_MS,
      maxBuffer: DOCKER_COMMAND_MAX_BUFFER,
      windowsHide: true,
    });

    return success({ stdout: result.stdout, stderr: result.stderr });
  } catch (error) {
    const message = asErrorMessage(error);
    const streams = extractStdStreams(error);
    const details = [streams.stderr.trim(), streams.stdout.trim(), message].filter(Boolean).join("\n");

    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return failure(
        "DOCKER_NOT_INSTALLED",
        "Docker CLI was not found on PATH.",
        details || null,
      );
    }

    if (dockerDaemonUnavailableMessage(details || message)) {
      return failure(
        "DOCKER_DAEMON_UNAVAILABLE",
        "Docker daemon is unavailable.",
        details || null,
      );
    }

    return failure(
      "DOCKER_COMMAND_FAILED",
      "Docker command failed.",
      details || null,
    );
  }
}

function firstNonEmptyLine(value: string): string | null {
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return null;
}

function parseContainerListLine(line: string): { id: string; name: string } | null {
  const parts = line.split("\t");
  if (parts.length < 2) {
    return null;
  }

  const id = parts[0]?.trim();
  const name = parts[1]?.trim();

  if (!id || !name) {
    return null;
  }

  return { id, name };
}

function readOptionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  return null;
}

function readRequiredString(record: Record<string, unknown>, key: string): string | null {
  const value = readOptionalString(record, key);
  if (!value) {
    return null;
  }

  return value;
}

function normalizeContainerIdentifier(value: string): string {
  return value.trim();
}

function parseHumanSizeToBytes(value: string): number | null {
  const match = value.trim().match(/^([0-9]*\.?[0-9]+)\s*([kmgtp]?i?b)$/i);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1_000,
    mb: 1_000_000,
    gb: 1_000_000_000,
    tb: 1_000_000_000_000,
    pb: 1_000_000_000_000_000,
    kib: 1_024,
    mib: 1_048_576,
    gib: 1_073_741_824,
    tib: 1_099_511_627_776,
    pib: 1_125_899_906_842_624,
  };

  const multiplier = multipliers[unit];
  if (!multiplier) {
    return null;
  }

  return Math.round(amount * multiplier);
}

function parseWritableSize(sizeField: string): { size: string; sizeBytes: number | null } | null {
  const trimmed = sizeField.trim();
  if (!trimmed) {
    return null;
  }

  const writable = trimmed.split("(")[0]?.trim() ?? trimmed;
  if (!writable) {
    return null;
  }

  return {
    size: writable,
    sizeBytes: parseHumanSizeToBytes(writable),
  };
}

function parseDockerPsSizeLine(line: string): { id: string; name: string; size: string; sizeBytes: number | null } | null {
  const parts = line.split("\t");
  if (parts.length < 3) {
    return null;
  }

  const id = parts[0]?.trim() ?? "";
  const name = parts[1]?.trim() ?? "";
  const sizeRaw = parts.slice(2).join("\t").trim();

  if (!id || !name || !sizeRaw) {
    return null;
  }

  const parsedSize = parseWritableSize(sizeRaw);
  if (!parsedSize) {
    return null;
  }

  return {
    id,
    name,
    size: parsedSize.size,
    sizeBytes: parsedSize.sizeBytes,
  };
}

async function fetchDockerContainerDiskSize(
  containerIdOrName: string,
): Promise<DockerResult<{ size: string; sizeBytes: number | null }>> {
  const containerRef = normalizeContainerIdentifier(containerIdOrName);
  if (!containerRef) {
    return failure("CONTAINER_NOT_FOUND", "Container identifier is empty.", null);
  }

  const argsById = [
    "ps",
    "--size",
    "--no-trunc",
    "--filter",
    `id=${containerRef}`,
    "--format",
    "{{.ID}}\t{{.Names}}\t{{.Size}}",
  ];

  const byId = await runDocker(argsById);
  if (!byId.ok) {
    return byId;
  }

  let parsed = parseDockerPsSizeLine(firstNonEmptyLine(byId.data.stdout) ?? "");

  if (!parsed) {
    const argsByName = [
      "ps",
      "--size",
      "--no-trunc",
      "--filter",
      `name=${containerRef}`,
      "--format",
      "{{.ID}}\t{{.Names}}\t{{.Size}}",
    ];

    const byName = await runDocker(argsByName);
    if (!byName.ok) {
      return byName;
    }

    parsed = parseDockerPsSizeLine(firstNonEmptyLine(byName.data.stdout) ?? "");
  }

  if (!parsed) {
    return failure(
      "CONTAINER_NOT_FOUND",
      `Docker container '${containerRef}' was not found.`,
      null,
    );
  }

  return success({
    size: parsed.size,
    sizeBytes: parsed.sizeBytes,
  });
}

function parseDockerLabelString(value: string): Record<string, string> {
  const labels: Record<string, string> = {};

  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const labelValue = trimmed.slice(separator + 1).trim();

    if (!key) {
      continue;
    }

    labels[key] = labelValue;
  }

  return labels;
}

function sanitizeContainerName(value: string): string {
  return value.split(",")[0]?.trim().replace(/^\//, "") ?? "";
}

function parsePublishedPort(ports: string): number | null {
  const patterns = [/:(\d+)->\d+\//g, /(^|\s|,)(\d+)->\d+\//g];

  for (const pattern of patterns) {
    const match = pattern.exec(ports);
    if (!match) {
      continue;
    }

    const value = Number(match[match.length - 1]);
    if (Number.isInteger(value) && value > 0) {
      return value;
    }
  }

  return null;
}

function parseDockerPsRecord(record: Record<string, unknown>): DockerDiscoveredContainer | null {
  const id = readRequiredString(record, "ID") ?? readRequiredString(record, "ContainerID");
  const rawName = readRequiredString(record, "Names") ?? readRequiredString(record, "Name");

  if (!id || !rawName) {
    return null;
  }

  const labelsRaw = readOptionalString(record, "Labels") ?? "";
  const ports = readOptionalString(record, "Ports") ?? "";

  return {
    id,
    name: sanitizeContainerName(rawName),
    labels: parseDockerLabelString(labelsRaw),
    ports,
  };
}

function parseDockerPsJsonOutput(output: string): DockerResult<DockerDiscoveredContainer[]> {
  const trimmed = output.trim();
  if (!trimmed) {
    return success([]);
  }

  // Newer Docker CLI builds may return either NDJSON lines or a single JSON array.
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      return failure("DOCKER_OUTPUT_PARSE_ERROR", "Docker ps output is not valid JSON.", asErrorMessage(error));
    }

    if (!Array.isArray(parsed)) {
      return failure("DOCKER_OUTPUT_PARSE_ERROR", "Docker ps output JSON must be an array.", trimmed);
    }

    const containers: DockerDiscoveredContainer[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const parsedContainer = parseDockerPsRecord(item as Record<string, unknown>);
      if (parsedContainer) {
        containers.push(parsedContainer);
      }
    }

    return success(containers);
  }

  const containers: DockerDiscoveredContainer[] = [];

  for (const line of output.split(/\r?\n/)) {
    const jsonLine = line.trim();
    if (!jsonLine) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonLine);
    } catch (error) {
      return failure(
        "DOCKER_OUTPUT_PARSE_ERROR",
        "Docker ps line is not valid JSON.",
        `${jsonLine}\n${asErrorMessage(error)}`,
      );
    }

    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    const parsedContainer = parseDockerPsRecord(parsed as Record<string, unknown>);
    if (parsedContainer) {
      containers.push(parsedContainer);
    }
  }

  return success(containers);
}

export function mapDiscoveredContainersToServices(
  containers: readonly DockerDiscoveredContainer[],
  defaultIcon = "🐳",
): DockerDiscoveryService[] {
  const services: DockerDiscoveryService[] = [];

  for (const container of containers) {
    const name = container.labels["homestat.name"]?.trim() || container.name;
    const icon = container.labels["homestat.icon"]?.trim() || defaultIcon;
    const explicitUrl = container.labels["homestat.url"]?.trim();
    const publishedPort = parsePublishedPort(container.ports);
    const fallbackUrl = publishedPort ? `http://localhost:${publishedPort}` : "http://localhost";

    services.push({
      source: "docker",
      containerId: container.id,
      containerName: container.name,
      name: name || container.id,
      url: explicitUrl || fallbackUrl,
      icon,
    });
  }

  return services;
}

export function mergeStaticAndDockerServices(
  staticServices: readonly Service[],
  dockerServices: readonly DockerDiscoveryService[],
): Service[] {
  const existingStaticContainerIds = new Set(
    staticServices
      .map((service) => service.containerId?.trim())
      .filter((value): value is string => Boolean(value)),
  );

  const seenDockerContainerIds = new Set<string>();
  const dedupedDocker: DockerDiscoveryService[] = [];

  for (const service of dockerServices) {
    const id = service.containerId.trim();
    if (!id || existingStaticContainerIds.has(id) || seenDockerContainerIds.has(id)) {
      continue;
    }

    seenDockerContainerIds.add(id);
    dedupedDocker.push(service);
  }

  return [...staticServices, ...dedupedDocker];
}

export async function discoverHomestatDockerServices(
  defaultIcon = "🐳",
): Promise<DockerResult<DockerDiscoveryService[]>> {
  const result = await runDocker([
    "ps",
    "--filter",
    "label=homestat.enabled=true",
    "--format",
    "json",
  ]);

  if (!result.ok) {
    return result;
  }

  const parsed = parseDockerPsJsonOutput(result.data.stdout);
  if (!parsed.ok) {
    return parsed;
  }

  return success(mapDiscoveredContainersToServices(parsed.data, defaultIcon));
}

export function isLocalServiceUrl(url: string): boolean {
  const parsed = parseServiceUrl(url);
  if (!parsed) {
    return false;
  }

  return (
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "0.0.0.0" ||
    parsed.hostname === "::1"
  );
}

export async function resolveServiceContainer(
  service: Pick<Service, "url" | "containerId" | "containerName">,
): Promise<DockerResult<DockerContainerRef>> {
  const configuredId = service.containerId?.trim();
  const configuredName = service.containerName?.trim();

  if (configuredId || configuredName) {
    return success({
      id: configuredId ?? null,
      name: configuredName ?? configuredId ?? "",
      source: "configured",
      port: null,
    });
  }

  const parsed = parseServiceUrl(service.url);
  if (!parsed) {
    return failure("INVALID_SERVICE_URL", "Could not parse service URL.", service.url);
  }

  if (!isLocalServiceUrl(service.url)) {
    return failure(
      "NON_LOCAL_SERVICE",
      "Service URL is not local, Docker container lookup is skipped.",
      parsed.hostname,
    );
  }

  const listByPublish = await runDocker([
    "ps",
    "--filter",
    `publish=${parsed.port}`,
    "--format",
    "{{.ID}}\t{{.Names}}",
  ]);

  if (!listByPublish.ok) {
    return listByPublish;
  }

  let line = firstNonEmptyLine(listByPublish.data.stdout);

  if (!line) {
    const listByExpose = await runDocker([
      "ps",
      "--filter",
      `expose=${parsed.port}`,
      "--format",
      "{{.ID}}\t{{.Names}}",
    ]);

    if (!listByExpose.ok) {
      return listByExpose;
    }

    line = firstNonEmptyLine(listByExpose.data.stdout);
  }

  if (!line) {
    return failure(
      "CONTAINER_NOT_FOUND",
      `No running Docker container found for port ${parsed.port}.`,
      null,
    );
  }

  const parsedLine = parseContainerListLine(line);
  if (!parsedLine) {
    return failure(
      "DOCKER_OUTPUT_PARSE_ERROR",
      "Unable to parse Docker container list output.",
      line,
    );
  }

  return success({
    id: parsedLine.id,
    name: parsedLine.name,
    source: "port_lookup",
    port: parsed.port,
  });
}

export function parseDockerStatsJsonLine(
  jsonLine: string,
  collectedAt = Date.now(),
): DockerResult<DockerContainerStats> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonLine);
  } catch (error) {
    return failure(
      "DOCKER_OUTPUT_PARSE_ERROR",
      "Docker stats output is not valid JSON.",
      `${jsonLine}\n${asErrorMessage(error)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    return failure(
      "DOCKER_OUTPUT_PARSE_ERROR",
      "Docker stats output JSON is not an object.",
      jsonLine,
    );
  }

  const record = parsed as Record<string, unknown>;
  const containerId = readRequiredString(record, "ID") ?? readRequiredString(record, "Container");
  const containerName = readRequiredString(record, "Name") ?? readRequiredString(record, "Container");
  const cpuUsage = readRequiredString(record, "CPUPerc");
  const memoryUsage = readRequiredString(record, "MemUsage");
  const diskUsage = readRequiredString(record, "BlockIO");

  if (!containerId || !containerName || !cpuUsage || !memoryUsage || !diskUsage) {
    return failure(
      "DOCKER_OUTPUT_PARSE_ERROR",
      "Docker stats output is missing one or more expected fields.",
      jsonLine,
    );
  }

  return success({
    containerId,
    containerName,
    cpuUsage,
    memoryUsage,
    memoryPercent: readOptionalString(record, "MemPerc"),
    diskUsage,
    diskSize: null,
    diskSizeBytes: null,
    networkIO: readOptionalString(record, "NetIO"),
    pids: readOptionalString(record, "PIDs"),
    collectedAt,
  });
}

export function parseDockerStatsOutput(
  output: string,
  collectedAt = Date.now(),
): DockerResult<DockerContainerStats> {
  const jsonLine = firstNonEmptyLine(output);
  if (!jsonLine) {
    return failure(
      "DOCKER_OUTPUT_PARSE_ERROR",
      "Docker stats command returned empty output.",
      output,
    );
  }

  return parseDockerStatsJsonLine(jsonLine, collectedAt);
}

export async function fetchDockerContainerStats(
  containerIdOrName: string,
): Promise<DockerResult<DockerContainerStats>> {
  const containerRef = normalizeContainerIdentifier(containerIdOrName);
  if (!containerRef) {
    return failure("CONTAINER_NOT_FOUND", "Container identifier is empty.", null);
  }

  const statsResult = await runDocker([
    "stats",
    containerRef,
    "--no-stream",
    "--format",
    "{{ json . }}",
  ]);

  if (!statsResult.ok) {
    if (/No such container/i.test(statsResult.error.details ?? "")) {
      return failure(
        "CONTAINER_NOT_FOUND",
        `Docker container '${containerRef}' was not found.`,
        statsResult.error.details,
      );
    }

    return statsResult;
  }

  const parsedStats = parseDockerStatsOutput(statsResult.data.stdout);
  if (!parsedStats.ok) {
    return parsedStats;
  }

  const diskSizeResult = await fetchDockerContainerDiskSize(containerRef);
  if (diskSizeResult.ok) {
    return success({
      ...parsedStats.data,
      diskSize: diskSizeResult.data.size,
      diskSizeBytes: diskSizeResult.data.sizeBytes,
    });
  }

  return success(parsedStats.data);
}

export async function getServiceDockerStats(
  service: Pick<Service, "url" | "containerId" | "containerName">,
): Promise<DockerResult<{ container: DockerContainerRef; stats: DockerContainerStats }>> {
  const containerResult = await resolveServiceContainer(service);
  if (!containerResult.ok) {
    return containerResult;
  }

  const identifier = containerResult.data.id ?? containerResult.data.name;
  const statsResult = await fetchDockerContainerStats(identifier);
  if (!statsResult.ok) {
    return statsResult;
  }

  return success({
    container: containerResult.data,
    stats: statsResult.data,
  });
}

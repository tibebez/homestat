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
  networkIO: string | null;
  pids: string | null;
  collectedAt: number;
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

  return parseDockerStatsOutput(statsResult.data.stdout);
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

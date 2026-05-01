import "@opentui/core/runtime-plugin-support";
import { BoxRenderable, createCliRenderer, type KeyEvent, TextRenderable, t, bold, fg, bg } from "@opentui/core";
import open from "open";
import { loadConfig, saveConfig } from "./config.ts";
import {
  createInitialHealth,
  evaluateStatus,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_CHECK_TIMEOUT_MS,
  normalizeServiceUrl,
  relativeTime,
} from "./health.ts";
import { getServiceDockerStats, resolveServiceContainer } from "./docker.ts";
import type { Service, ServiceHealth } from "./types.ts";

const COLORS = {
  online: "#22c55e",
  offline: "#ef4444",
  unknown: "#6b7280",
  focused: "#c084fc",
  text: "#f9fafb",
  muted: "#9ca3af",
  cardBg: "#18181b",
  cardBorder: "#27272a",
  cardBorderFocused: "#a78bfa",
  iconBg: "#14532d",
  iconFg: "#4ade80",
} as const;

const ICON_PRESETS = ["•", "🐳", "⚡", "🚀", "🗄️", "🌐", "🔒", "📊", "💾", "🔧", "📡", "🖥️"];

function truncate(value: string, length: number): string {
  if (value.length <= length) {
    return value;
  }
  return `${value.slice(0, Math.max(0, length - 1))}…`;
}

function capitalizeFirstLetter(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function formFieldLine(
  label: string,
  value: string,
  focused: boolean,
  panelWidth: number,
): string {
  const prefix = `${focused ? "> " : "  "}${label}: `;
  const contentWidth = Math.max(10, panelWidth - 4);
  const maxValueLen = Math.max(3, contentWidth - prefix.length - (focused ? 1 : 0));
  const displayValue = truncate(value, maxValueLen) + (focused ? "|" : "");
  return `${prefix}${displayValue}`;
}

async function checkService(
  url: string,
): Promise<Pick<ServiceHealth, "state" | "errorCode" | "errorDetails">> {
  const normalized = normalizeServiceUrl(url);

  try {
    const response = await fetch(normalized, {
      method: "GET",
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });

    return {
      state: evaluateStatus(response.status),
      errorCode: response.status >= 400 ? `HTTP_${response.status}` : null,
      errorDetails:
        response.status >= 400 ? `Request failed with status ${response.status}.` : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timeout = /timeout/i.test(message);
    return {
      state: "offline",
      errorCode: timeout ? "TIMEOUT" : "NETWORK",
      errorDetails: message,
    };
  }
}

type RuntimeStatsState = "unknown" | "available" | "unavailable" | "not-applicable";

interface ServiceRuntimeStats {
  state: RuntimeStatsState;
  source: "docker" | null;
  containerName: string | null;
  cpuUsage: string | null;
  memoryUsage: string | null;
  diskUsage: string | null;
  lastCheckedAt: number | null;
  errorCode: string | null;
  errorDetails: string | null;
}

function createInitialRuntimeStats(): ServiceRuntimeStats {
  return {
    state: "unknown",
    source: null,
    containerName: null,
    cpuUsage: null,
    memoryUsage: null,
    diskUsage: null,
    lastCheckedAt: null,
    errorCode: null,
    errorDetails: null,
  };
}

async function main() {
  const config = await loadConfig();
  const services = config.services;

  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    useMouse: false,
    exitOnCtrlC: false,
  });

  const root = new BoxRenderable(renderer, {
    id: "root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    padding: 1,
    gap: 1,
  });

  const mainArea = new BoxRenderable(renderer, {
    id: "main-area",
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
  });

  const servicesPanel = new BoxRenderable(renderer, {
    id: "services-panel",
    width: "68%",
    height: "100%",
    border: true,
    title: "Services",
    padding: 1,
  });

  const detailsPanel = new BoxRenderable(renderer, {
    id: "details-panel",
    width: "32%",
    height: "100%",
    border: true,
    title: "Details",
    padding: 1,
    gap: 0,
  });

  const footer = new BoxRenderable(renderer, {
    id: "footer",
    width: "100%",
    height: 1,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
  });

  const footerText = new TextRenderable(renderer, {
    id: "footer-text",
    content: "",
    fg: COLORS.muted,
  });
  footer.add(footerText);

  const cardsViewport = new BoxRenderable(renderer, {
    id: "cards-viewport",
    width: "100%",
    height: "100%",
    overflow: "hidden",
  });

  const cardsGrid = new BoxRenderable(renderer, {
    id: "cards-grid",
    width: "100%",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: 1,
  });

  const CARD_COLUMNS = 2;
  const CARD_HEIGHT = 9;
  const CARD_ROW_STRIDE = CARD_HEIGHT + 1;

  const rowTexts = services.map(
    (_, index) =>
      new BoxRenderable(renderer, {
        id: `service-row-${index}`,
        width: "48%",
        height: CARD_HEIGHT,
        padding: 1,
        border: true,
        flexDirection: "column",
        justifyContent: "space-between",
        backgroundColor: COLORS.cardBg,
        borderColor: COLORS.cardBorder,
      }),
  );

  const cardHeaderBoxes = services.map(
    (_, index) =>
      new BoxRenderable(renderer, {
        id: `service-header-${index}`,
        width: "100%",
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
      }),
  );

  const cardIconTexts = services.map(
    (_, index) =>
      new TextRenderable(renderer, {
        id: `service-icon-${index}`,
        content: "",
      }),
  );

  const cardStatusTexts = services.map(
    (_, index) =>
      new TextRenderable(renderer, {
        id: `service-status-${index}`,
        content: "",
      }),
  );

  const cardBottomTexts = services.map(
    (_, index) =>
      new TextRenderable(renderer, {
        id: `service-bottom-${index}`,
        content: "",
        fg: COLORS.text,
      }),
  );

  const detailsTitle = new TextRenderable(renderer, {
    id: "details-title",
    content: "",
    fg: COLORS.focused,
  });

  const detailsUrl = new TextRenderable(renderer, {
    id: "details-url",
    content: "",
    fg: COLORS.text,
  });

  const detailsHealth = new TextRenderable(renderer, {
    id: "details-health",
    content: "",
    fg: COLORS.text,
  });

  const detailsChecked = new TextRenderable(renderer, {
    id: "details-checked",
    content: "",
    fg: COLORS.text,
  });

  const detailsError = new TextRenderable(renderer, {
    id: "details-error",
    content: "",
    fg: COLORS.text,
  });

  const detailsRuntime = new TextRenderable(renderer, {
    id: "details-runtime",
    content: "",
    fg: COLORS.text,
  });

  const detailsCpu = new TextRenderable(renderer, {
    id: "details-cpu",
    content: "",
    fg: COLORS.text,
  });

  const detailsRam = new TextRenderable(renderer, {
    id: "details-ram",
    content: "",
    fg: COLORS.text,
  });

  const detailsDisk = new TextRenderable(renderer, {
    id: "details-disk",
    content: "",
    fg: COLORS.text,
  });

  renderer.root.add(root);
  root.add(mainArea);
  root.add(footer);
  mainArea.add(servicesPanel);
  mainArea.add(detailsPanel);

  servicesPanel.add(cardsViewport);
  cardsViewport.add(cardsGrid);

  for (const [index, rowText] of rowTexts.entries()) {
    cardsGrid.add(rowText);
    rowText.add(cardHeaderBoxes[index]);
    cardHeaderBoxes[index].add(cardIconTexts[index]);
    cardHeaderBoxes[index].add(cardStatusTexts[index]);
    rowText.add(cardBottomTexts[index]);
  }

  detailsPanel.add(detailsTitle);
  detailsPanel.add(detailsUrl);
  detailsPanel.add(detailsHealth);
  detailsPanel.add(detailsChecked);
  detailsPanel.add(detailsError);
  detailsPanel.add(detailsRuntime);
  detailsPanel.add(detailsCpu);
  detailsPanel.add(detailsRam);
  detailsPanel.add(detailsDisk);

  const health = services.map(() => createInitialHealth());
  const runtimeStats = services.map(() => createInitialRuntimeStats());
  let selectedIndex = 0;
  let scrollRowOffset = 0;

  let isFormActive = false;
  const formFields = {
    serviceName: "",
    url: "",
    containerId: "",
    iconIndex: 0,
  };
  let focusedFieldIndex = 0;
  let formError = "";
  let isSubmitting = false;
  let formMode: "add" | "edit" = "add";
  let editingIndex = -1;

  function resetForm() {
    formFields.serviceName = "";
    formFields.url = "";
    formFields.containerId = "";
    formFields.iconIndex = 0;
    focusedFieldIndex = 0;
    formError = "";
    formMode = "add";
    editingIndex = -1;
  }

  function startEditForm(index: number) {
    const service = services[index];
    formFields.serviceName = service.name;
    formFields.url = service.url;
    formFields.containerId = service.containerId ?? "";
    formFields.iconIndex = Math.max(0, ICON_PRESETS.indexOf(service.icon ?? "•"));
    focusedFieldIndex = 0;
    formError = "";
    formMode = "edit";
    editingIndex = index;
    isFormActive = true;
  }

  function iconDisplay(): string {
    const icon = ICON_PRESETS[formFields.iconIndex];
    return `${icon} (${formFields.iconIndex + 1}/${ICON_PRESETS.length})`;
  }

  async function submitForm() {
    if (isSubmitting) return;
    isSubmitting = true;

    try {
      if (!formFields.serviceName.trim()) {
        formError = "Error: Service name is required.";
        safeRender();
        return;
      }
      if (!formFields.url.trim()) {
        formError = "Error: URL is required.";
        safeRender();
        return;
      }

      const serviceData: Service = {
        name: capitalizeFirstLetter(formFields.serviceName),
        url: formFields.url.trim(),
        containerId: formFields.containerId.trim() || undefined,
        icon: ICON_PRESETS[formFields.iconIndex],
      };

      if (formMode === "edit" && editingIndex >= 0) {
        config.services[editingIndex] = {
          ...config.services[editingIndex],
          ...serviceData,
        };
        await saveConfig(config);

        isFormActive = false;
        formError = "";
        selectedIndex = editingIndex;
        safeRender();

        void refreshServiceAndDetectContainer(editingIndex).then(() => {
          safeRender();
        });
        return;
      }

      config.services.push(serviceData);
      await saveConfig(config);

      const newIndex = services.length - 1;
      const newRowText = new BoxRenderable(renderer, {
        id: `service-row-${newIndex}`,
        width: "48%",
        height: CARD_HEIGHT,
        padding: 1,
        border: true,
        flexDirection: "column",
        justifyContent: "space-between",
        backgroundColor: COLORS.cardBg,
        borderColor: COLORS.cardBorder,
      });
      const newHeaderBox = new BoxRenderable(renderer, {
        id: `service-header-${newIndex}`,
        width: "100%",
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
      });
      const newIconText = new TextRenderable(renderer, {
        id: `service-icon-${newIndex}`,
        content: "",
      });
      const newStatusText = new TextRenderable(renderer, {
        id: `service-status-${newIndex}`,
        content: "",
      });
      const newBottomText = new TextRenderable(renderer, {
        id: `service-bottom-${newIndex}`,
        content: "",
        fg: COLORS.text,
      });

      newRowText.add(newHeaderBox);
      newHeaderBox.add(newIconText);
      newHeaderBox.add(newStatusText);
      newRowText.add(newBottomText);
      cardsGrid.add(newRowText);

      rowTexts.push(newRowText);
      cardHeaderBoxes.push(newHeaderBox);
      cardIconTexts.push(newIconText);
      cardStatusTexts.push(newStatusText);
      cardBottomTexts.push(newBottomText);
      health.push(createInitialHealth());
      runtimeStats.push(createInitialRuntimeStats());

      isFormActive = false;
      selectedIndex = newIndex;
      formError = "";

      safeRender();

      void refreshServiceAndDetectContainer(newIndex).then(() => {
        safeRender();
      });
    } finally {
      isSubmitting = false;
    }
  }

  async function deleteService(index: number) {
    if (index < 0 || index >= services.length) return;

    config.services.splice(index, 1);
    await saveConfig(config);

    cardsGrid.remove(rowTexts[index].id);

    rowTexts.splice(index, 1);
    cardHeaderBoxes.splice(index, 1);
    cardIconTexts.splice(index, 1);
    cardStatusTexts.splice(index, 1);
    cardBottomTexts.splice(index, 1);
    health.splice(index, 1);
    runtimeStats.splice(index, 1);

    if (services.length === 0) {
      selectedIndex = 0;
    } else if (selectedIndex > index) {
      selectedIndex--;
    } else if (selectedIndex >= services.length) {
      selectedIndex = services.length - 1;
    }

    safeRender();
  }

  async function toggleBookmark(index: number) {
    if (index < 0 || index >= services.length) return;

    const service = config.services[index];
    service.bookmarked = !service.bookmarked;
    await saveConfig(config);

    safeRender();
  }

  const statusText = (state: ServiceHealth["state"]): string => {
    if (state === "online") {
      return "ONLINE";
    }
    if (state === "offline") {
      return "OFFLINE";
    }
    return "UNKNOWN";
  };

  const statusColor = (state: ServiceHealth["state"]): string => {
    if (state === "online") {
      return COLORS.online;
    }
    if (state === "offline") {
      return COLORS.offline;
    }
    return COLORS.unknown;
  };

  const render = () => {
    for (const [index, service] of services.entries()) {
      const rowHealth = health[index];
      const icon = service.icon ?? "•";
      const name = truncate(capitalizeFirstLetter(service.name), 20);
      const description = service.description
        ? truncate(service.description, 30)
        : truncate(service.url, 30);
      const badge = statusText(rowHealth.state);
      const focused = index === selectedIndex;

      const iconChunk = fg(COLORS.iconFg)(bg(COLORS.iconBg)(` ${icon} `));
      cardIconTexts[index].content = t`${iconChunk}`;

      const badgeColor = statusColor(rowHealth.state);
      cardStatusTexts[index].content = service.bookmarked
        ? t`${fg(badgeColor)(`[ ${badge} ]`)} ${fg(COLORS.muted)("★")}`
        : t`${fg(badgeColor)(`[ ${badge} ]`)}`;

      const nameColor = focused ? COLORS.focused : COLORS.text;
      cardBottomTexts[index].content = t`${bold(fg(nameColor)(name))}\n${fg(COLORS.muted)(description)}`;

      rowTexts[index].borderStyle = focused ? "double" : "single";
      rowTexts[index].borderColor = focused ? COLORS.cardBorderFocused : COLORS.cardBorder;
    }


    const selectedRow = Math.floor(selectedIndex / CARD_COLUMNS);
    const visibleRows = Math.max(1, Math.floor(cardsViewport.height / CARD_ROW_STRIDE));

    if (selectedRow < scrollRowOffset) {
      scrollRowOffset = selectedRow;
    } else if (selectedRow >= scrollRowOffset + visibleRows) {
      scrollRowOffset = selectedRow - visibleRows + 1;
    }

    cardsGrid.translateY = -(scrollRowOffset * CARD_ROW_STRIDE);

    const pw = detailsPanel.width;
    const contentWidth = Math.max(10, pw - 4);

    if (isFormActive) {
      const FIELDS = {
        serviceName: 0,
        url: 1,
        containerId: 2,
        icon: 3,
        save: 4,
      };

      detailsTitle.content = formMode === "edit" ? "✎ Edit Service" : "+ Add New Service";
      detailsTitle.fg = COLORS.focused;

      const serviceNameFocused = focusedFieldIndex === FIELDS.serviceName;
      detailsUrl.content = formFieldLine("Name", formFields.serviceName, serviceNameFocused, pw);
      detailsUrl.fg = serviceNameFocused ? COLORS.focused : COLORS.text;

      const urlFocused = focusedFieldIndex === FIELDS.url;
      detailsHealth.content = formFieldLine("URL", formFields.url, urlFocused, pw);
      detailsHealth.fg = urlFocused ? COLORS.focused : COLORS.text;

      const containerIdFocused = focusedFieldIndex === FIELDS.containerId;
      detailsChecked.content = formFieldLine("Container ID", formFields.containerId, containerIdFocused, pw);
      detailsChecked.fg = containerIdFocused ? COLORS.focused : COLORS.text;

      const iconFocused = focusedFieldIndex === FIELDS.icon;
      detailsError.content = formFieldLine("Icon", iconDisplay(), iconFocused, pw);
      detailsError.fg = iconFocused ? COLORS.focused : COLORS.text;

      if (formError) {
        const errorPrefix = "Error: ";
        detailsRuntime.content = errorPrefix + truncate(formError.slice(errorPrefix.length), Math.max(3, contentWidth - errorPrefix.length));
        detailsRuntime.fg = COLORS.offline;
      } else {
        const saveFocused = focusedFieldIndex === FIELDS.save;
        detailsRuntime.content = `${saveFocused ? "> " : "  "}[Save]`;
        detailsRuntime.fg = saveFocused ? COLORS.focused : COLORS.muted;
      }

      detailsCpu.content = "";
      detailsCpu.fg = COLORS.text;
      detailsRam.content = "";
      detailsRam.fg = COLORS.text;
      detailsDisk.content = "";
      detailsDisk.fg = COLORS.text;

      footerText.content = "↑/↓ navigate fields • ←/→ icon • Type to edit • Enter to save • Esc to cancel";
    } else if (services.length === 0) {
      detailsTitle.content = "No Services Yet";
      detailsTitle.fg = COLORS.focused;

      detailsUrl.content = "Press n to add your first service";
      detailsUrl.fg = COLORS.muted;

      detailsHealth.content = "";
      detailsHealth.fg = COLORS.text;

      detailsChecked.content = "";
      detailsChecked.fg = COLORS.text;

      detailsError.content = "";
      detailsError.fg = COLORS.text;

      detailsRuntime.content = "";
      detailsRuntime.fg = COLORS.text;
      detailsCpu.content = "";
      detailsCpu.fg = COLORS.text;
      detailsRam.content = "";
      detailsRam.fg = COLORS.text;
      detailsDisk.content = "";
      detailsDisk.fg = COLORS.text;

      footerText.content = "n new service • r refresh • Ctrl+C quit";
    } else {
      const selected = services[selectedIndex];
      const selectedHealth = health[selectedIndex];
      const selectedRuntime = runtimeStats[selectedIndex];

      const bookmarkPrefix = selected.bookmarked ? "★ " : "";
      const titlePrefix = `${selected.icon ?? "•"} ${bookmarkPrefix}`;
      detailsTitle.content =
        titlePrefix + truncate(capitalizeFirstLetter(selected.name), Math.max(3, contentWidth - titlePrefix.length));
      detailsTitle.fg = COLORS.focused;

      const urlPrefix = "URL: ";
      detailsUrl.content = urlPrefix + truncate(selected.url, Math.max(3, contentWidth - urlPrefix.length));
      detailsUrl.fg = COLORS.text;

      const healthPrefix = "Health: ";
      const healthText = statusText(selectedHealth.state);
      detailsHealth.content = healthPrefix + healthText;
      detailsHealth.fg = statusColor(selectedHealth.state);

      const checkedPrefix = "Last checked: ";
      detailsChecked.content = checkedPrefix + truncate(relativeTime(selectedHealth.lastCheckedAt), Math.max(3, contentWidth - checkedPrefix.length));
      detailsChecked.fg = COLORS.text;

      const errorPrefix = "Error: ";
      detailsError.content = errorPrefix + truncate(selectedHealth.errorDetails ?? "none", Math.max(3, contentWidth - errorPrefix.length));
      detailsError.fg = COLORS.text;

      const runtimePrefix = "Runtime: ";
      const cpuPrefix = "CPU: ";
      const ramPrefix = "RAM: ";
      const diskPrefix = "Disk: ";

      if (selectedRuntime.state === "available") {
        const runtimeLabel = selectedRuntime.containerName
          ? `Docker (${selectedRuntime.containerName})`
          : "Docker";
        detailsRuntime.content = runtimePrefix + truncate(runtimeLabel, Math.max(3, contentWidth - runtimePrefix.length));
        detailsRuntime.fg = COLORS.text;

        detailsCpu.content = cpuPrefix + truncate(selectedRuntime.cpuUsage ?? "-", Math.max(3, contentWidth - cpuPrefix.length));
        detailsCpu.fg = COLORS.text;

        detailsRam.content = ramPrefix + truncate(selectedRuntime.memoryUsage ?? "-", Math.max(3, contentWidth - ramPrefix.length));
        detailsRam.fg = COLORS.text;

        detailsDisk.content = diskPrefix + truncate(selectedRuntime.diskUsage ?? "-", Math.max(3, contentWidth - diskPrefix.length));
        detailsDisk.fg = COLORS.text;
      } else if (selectedRuntime.state === "not-applicable") {
        detailsRuntime.content = runtimePrefix + truncate("N/A (non-local service)", Math.max(3, contentWidth - runtimePrefix.length));
        detailsRuntime.fg = COLORS.muted;

        detailsCpu.content = cpuPrefix + "-";
        detailsCpu.fg = COLORS.muted;
        detailsRam.content = ramPrefix + "-";
        detailsRam.fg = COLORS.muted;
        detailsDisk.content = diskPrefix + "-";
        detailsDisk.fg = COLORS.muted;
      } else if (selectedRuntime.state === "unavailable") {
        const runtimeMessage =
          selectedRuntime.errorCode === "CONTAINER_NOT_FOUND"
            ? "No container linked"
            : selectedRuntime.errorCode === "DOCKER_DAEMON_UNAVAILABLE" || selectedRuntime.errorCode === "DOCKER_NOT_INSTALLED"
              ? "Docker unavailable"
              : "Docker stats unavailable";

        detailsRuntime.content = runtimePrefix + truncate(runtimeMessage, Math.max(3, contentWidth - runtimePrefix.length));
        detailsRuntime.fg = COLORS.offline;

        detailsCpu.content = cpuPrefix + "-";
        detailsCpu.fg = COLORS.muted;
        detailsRam.content = ramPrefix + "-";
        detailsRam.fg = COLORS.muted;
        detailsDisk.content = diskPrefix + "-";
        detailsDisk.fg = COLORS.muted;
      } else {
        detailsRuntime.content = runtimePrefix + "loading…";
        detailsRuntime.fg = COLORS.muted;

        detailsCpu.content = cpuPrefix + "-";
        detailsCpu.fg = COLORS.muted;
        detailsRam.content = ramPrefix + "-";
        detailsRam.fg = COLORS.muted;
        detailsDisk.content = diskPrefix + "-";
        detailsDisk.fg = COLORS.muted;
      }

      const runtimeHint =
        selectedRuntime.state === "available"
          ? " • docker stats synced"
          : selectedRuntime.state === "unavailable"
            ? " • docker stats unavailable"
            : "";

      footerText.content = `←/→/↑/↓ navigate • n new • o open • b bookmark • e edit • d delete • r refresh • Ctrl+C quit${runtimeHint}`;
    }
  };

  let stopped = false;

  const safeRender = () => {
    if (stopped) {
      return;
    }
    render();
    renderer.requestRender();
  };

  const refreshServiceState = async (index: number) => {
    const service = services[index];
    if (!service) {
      return;
    }

    const [healthResult, runtimeResult] = await Promise.all([
      checkService(service.url),
      getServiceDockerStats(service),
    ]);

    health[index] = {
      state: healthResult.state,
      errorCode: healthResult.errorCode,
      errorDetails: healthResult.errorDetails,
      lastCheckedAt: Date.now(),
    };

    if (runtimeResult.ok) {
      runtimeStats[index] = {
        state: "available",
        source: "docker",
        containerName: runtimeResult.data.stats.containerName,
        cpuUsage: runtimeResult.data.stats.cpuUsage,
        memoryUsage: runtimeResult.data.stats.memoryUsage,
        diskUsage: runtimeResult.data.stats.diskUsage,
        lastCheckedAt: runtimeResult.data.stats.collectedAt,
        errorCode: null,
        errorDetails: null,
      };
      return;
    }

    if (runtimeResult.error.code === "NON_LOCAL_SERVICE") {
      runtimeStats[index] = {
        state: "not-applicable",
        source: null,
        containerName: null,
        cpuUsage: null,
        memoryUsage: null,
        diskUsage: null,
        lastCheckedAt: Date.now(),
        errorCode: runtimeResult.error.code,
        errorDetails: runtimeResult.error.message,
      };
      return;
    }

    runtimeStats[index] = {
      state: "unavailable",
      source: "docker",
      containerName: null,
      cpuUsage: null,
      memoryUsage: null,
      diskUsage: null,
      lastCheckedAt: Date.now(),
      errorCode: runtimeResult.error.code,
      errorDetails: runtimeResult.error.details ?? runtimeResult.error.message,
    };
  };

  const detectAndPersistServiceContainer = async (index: number): Promise<void> => {
    const service = services[index];
    if (!service) {
      return;
    }

    const resolution = await resolveServiceContainer(service);
    if (!resolution.ok) {
      return;
    }

    if (resolution.data.source !== "port_lookup") {
      return;
    }

    const resolvedId = resolution.data.id?.trim() || null;
    const resolvedName = resolution.data.name.trim();

    const nextContainerId = resolvedId ?? undefined;
    const nextContainerName = resolvedName || undefined;

    const hasChanges =
      service.containerId !== nextContainerId || service.containerName !== nextContainerName;

    if (!hasChanges) {
      return;
    }

    service.containerId = nextContainerId;
    service.containerName = nextContainerName;
    await saveConfig(config);
  };

  const refreshServiceAndDetectContainer = async (index: number): Promise<void> => {
    await refreshServiceState(index);

    try {
      await detectAndPersistServiceContainer(index);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtimeStats[index] = {
        ...runtimeStats[index],
        state: "unavailable",
        source: "docker",
        errorCode: "DOCKER_LINK_PERSIST_FAILED",
        errorDetails: message,
      };
    }
  };

  const refreshHealth = async () => {
    if (stopped) {
      return;
    }

    await Promise.all(services.map((_, index) => refreshServiceState(index)));

    if (stopped) {
      return;
    }

    safeRender();
  };

  safeRender();

  const healthInterval = setInterval(() => {
    void refreshHealth();
  }, HEALTH_CHECK_INTERVAL_MS);

  const relativeInterval = setInterval(() => {
    safeRender();
  }, 1_000);

  void refreshHealth();

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(healthInterval);
    clearInterval(relativeInterval);
    renderer.destroy();
  };

  const exitGracefully = () => {
    stop();
    process.exit(0);
  };

  const isTextField = (index: number): boolean => index === 0 || index === 1 || index === 2;

  const nextField = (): void => {
    const max = 4;
    focusedFieldIndex = (focusedFieldIndex + 1) % (max + 1);
  };

  const prevField = (): void => {
    const max = 4;
    focusedFieldIndex = (focusedFieldIndex - 1 + max + 1) % (max + 1);
  };

  renderer.keyInput.on("keypress", (event: KeyEvent) => {
    if (event.ctrl && event.name === "c") {
      event.preventDefault();
      exitGracefully();
      return;
    }

    if (isFormActive) {
      formError = "";

      if (event.name === "escape") {
        isFormActive = false;
        if (formMode === "edit" && editingIndex >= 0) {
          selectedIndex = editingIndex;
        } else if (services.length === 0) {
          selectedIndex = 0;
        } else if (selectedIndex >= services.length) {
          selectedIndex = services.length - 1;
        }
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "up") {
        prevField();
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "down") {
        nextField();
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "left" && focusedFieldIndex === 3) {
        formFields.iconIndex = (formFields.iconIndex - 1 + ICON_PRESETS.length) % ICON_PRESETS.length;
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "right" && focusedFieldIndex === 3) {
        formFields.iconIndex = (formFields.iconIndex + 1) % ICON_PRESETS.length;
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "return" || event.name === "enter") {
        if (focusedFieldIndex === 4) {
          void submitForm();
          event.preventDefault();
          return;
        }
      }

      if (event.name === "backspace") {
        if (isTextField(focusedFieldIndex)) {
          if (focusedFieldIndex === 0) {
            formFields.serviceName = formFields.serviceName.slice(0, -1);
          } else if (focusedFieldIndex === 1) {
            formFields.url = formFields.url.slice(0, -1);
          } else if (focusedFieldIndex === 2) {
            formFields.containerId = formFields.containerId.slice(0, -1);
          }
          safeRender();
        }
        event.preventDefault();
        return;
      }

      if (
        event.sequence.length === 1 &&
        event.sequence.charCodeAt(0) >= 32 &&
        !event.ctrl &&
        !event.meta
      ) {
        if (isTextField(focusedFieldIndex)) {
          if (focusedFieldIndex === 0) {
            formFields.serviceName += event.sequence;
          } else if (focusedFieldIndex === 1) {
            formFields.url += event.sequence;
          } else if (focusedFieldIndex === 2) {
            formFields.containerId += event.sequence;
          }
          safeRender();
        }
        event.preventDefault();
        return;
      }

      event.preventDefault();
      return;
    }

    if (event.name === "left") {
      if (services.length > 0) {
        selectedIndex = (selectedIndex - 1 + services.length) % services.length;
        safeRender();
      }
      event.preventDefault();
      return;
    }

    if (event.name === "right") {
      if (services.length > 0) {
        selectedIndex = (selectedIndex + 1) % services.length;
        safeRender();
      }
      event.preventDefault();
      return;
    }

    if (event.name === "up") {
      if (services.length > 0) {
        selectedIndex = (selectedIndex - CARD_COLUMNS + services.length) % services.length;
        safeRender();
      }
      event.preventDefault();
      return;
    }

    if (event.name === "down") {
      if (services.length > 0) {
        selectedIndex = (selectedIndex + CARD_COLUMNS) % services.length;
        safeRender();
      }
      event.preventDefault();
      return;
    }

    if ((event.sequence === "n" || event.name === "n") && !event.ctrl && !event.meta) {
      resetForm();
      isFormActive = true;
      safeRender();
      event.preventDefault();
      return;
    }

    if ((event.sequence === "o" || event.name === "o") && !event.ctrl && !event.meta) {
      if (services.length > 0) {
        const selected = services[selectedIndex];
        const normalized = normalizeServiceUrl(selected.url);
        void open(normalized);
      }
      event.preventDefault();
      return;
    }

    if ((event.sequence === "e" || event.name === "e") && !event.ctrl && !event.meta) {
      if (services.length > 0) {
        startEditForm(selectedIndex);
        safeRender();
      }
      event.preventDefault();
      return;
    }

    if ((event.sequence === "d" || event.name === "d") && !event.ctrl && !event.meta) {
      if (services.length > 0) {
        void deleteService(selectedIndex);
      }
      event.preventDefault();
      return;
    }

    if ((event.sequence === "b" || event.name === "b") && !event.ctrl && !event.meta) {
      if (services.length > 0) {
        void toggleBookmark(selectedIndex);
      }
      event.preventDefault();
      return;
    }

    if ((event.sequence === "r" || event.name === "r") && !event.ctrl && !event.meta) {
      void refreshHealth();
      event.preventDefault();
      return;
    }

  });

  process.once("SIGINT", exitGracefully);
  process.once("exit", stop);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`homestat: ${message}`);
  process.exit(1);
});

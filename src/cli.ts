import "@opentui/core/runtime-plugin-support";
import {
  BoxRenderable,
  createCliRenderer,
  type KeyEvent,
  type PasteEvent,
  TextRenderable,
  t,
  bold,
  fg,
  bg,
} from "@opentui/core";
import open from "open";
import { loadConfig, saveConfig } from "./config.ts";
import {
  createInitialHealth,
  evaluateStatus,
  HEALTH_CHECK_TIMEOUT_MS,
  normalizeServiceUrl,
} from "./health.ts";
import {
  discoverHomestatDockerServices,
  getServiceDockerStats,
  resolveServiceContainer,
} from "./docker.ts";
import {
  getDistinctGroupNames,
  getServiceGroupLabel,
  getServicesForView,
  isUngroupedService,
  type ServiceListView,
} from "./services.ts";
import type { ManualService, Service, ServiceHealth, WidgetService } from "./types.ts";
import { WIDGET_REGISTRY, getWidgetById } from "./widgets/index.ts";
import type { WidgetDefinition, WidgetField } from "./widgets/index.ts";

const COLORS = {
  online: "#22c55e",
  offline: "#ef4444",
  warning: "#f59e0b",
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
const ALL_SERVICES_TITLE = "All Services";


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

function fuzzyMatchService(query: string, service: Service): boolean {
  if (!query.trim()) return true;
  const q = query.toLowerCase();
  const haystack = [
    service.name,
    service.url,
    service.group || "",
    service.description || "",
    service.type === "docker" ? service.containerName : "",
    service.type === "docker" ? service.containerId : "",
  ].join(" ").toLowerCase();

  let idx = 0;
  for (const char of q) {
    const found = haystack.indexOf(char, idx);
    if (found === -1) return false;
    idx = found + 1;
  }
  return true;
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

function parsePercent(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const match = value.match(/([0-9]*\.?[0-9]+)\s*%/);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.max(0, Math.min(100, parsed));
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

function parseUsagePairPercent(usage: string | null): number | null {
  if (!usage || !usage.includes("/")) {
    return null;
  }

  const [usedRaw, totalRaw] = usage.split("/").map((part) => part.trim());
  if (!usedRaw || !totalRaw) {
    return null;
  }

  const used = parseHumanSizeToBytes(usedRaw);
  const total = parseHumanSizeToBytes(totalRaw);

  if (used === null || total === null || total <= 0) {
    return null;
  }

  return Math.max(0, Math.min(100, (used / total) * 100));
}

function usagePairUsedValue(usage: string | null): string {
  if (!usage) {
    return "-";
  }

  if (!usage.includes("/")) {
    return usage;
  }

  const [usedRaw] = usage.split("/").map((part) => part.trim());
  return usedRaw || "-";
}

function metricColor(percent: number | null): string {
  if (percent === null) {
    return COLORS.text;
  }

  if (percent >= 85) {
    return COLORS.offline;
  }

  if (percent >= 60) {
    return COLORS.warning;
  }

  return COLORS.online;
}

function renderMetricBar(label: string, value: string, percent: number | null, panelWidth: number): string {
  const contentWidth = Math.max(10, panelWidth - 4);
  const prefix = `${label}: `;

  if (percent === null) {
    return prefix + truncate(value, Math.max(3, contentWidth - prefix.length));
  }

  const boundedPercent = Math.max(0, Math.min(100, percent));
  const barWidth = Math.max(8, Math.min(18, Math.floor(contentWidth * 0.38)));
  const filled = Math.round((boundedPercent / 100) * barWidth);
  const bar = `${"█".repeat(filled)}${"░".repeat(Math.max(0, barWidth - filled))}`;
  const suffix = ` ${Math.round(boundedPercent)}% ${value}`;

  return truncate(`${prefix}[${bar}]${suffix}`, contentWidth);
}

function diskSizePercent(bytes: number | null): number | null {
  if (bytes === null || bytes < 0) {
    return null;
  }

  // Visual scale only (not a quota): 20 GiB ~= 100%.
  const referenceBytes = 20 * 1_073_741_824;
  return Math.max(0, Math.min(100, (bytes / referenceBytes) * 100));
}

function formatAggregatePercent(value: number | null): string {
  if (value === null) {
    return "-";
  }

  return `${Math.round(value)}%`;
}

function aggregateMetric(values: Array<number | null>): number | null {
  const numericValues = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (numericValues.length === 0) {
    return null;
  }

  const total = numericValues.reduce((sum, current) => sum + current, 0);
  return total / numericValues.length;
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
  memoryPercent: string | null;
  diskSize: string | null;
  diskSizeBytes: number | null;
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
    memoryPercent: null,
    diskSize: null,
    diskSizeBytes: null,
    lastCheckedAt: null,
    errorCode: null,
    errorDetails: null,
  };
}

async function main() {
  const config = await loadConfig();
  const configuredServices = config.services;
  const globalSettings = { ...config.settings };
  const services: Service[] = [...configuredServices];

  async function saveConfiguredState(): Promise<void> {
    await saveConfig({ services: configuredServices, settings: globalSettings });
  }

  function rebuildActiveServices(): void {
    services.splice(0, services.length, ...configuredServices);
  }

  async function refreshDockerDiscoveredServices(): Promise<void> {
    const dockerDiscovery = await discoverHomestatDockerServices("🐳");
    if (!dockerDiscovery.ok) {
      return;
    }

    let configChanged = false;

    for (const discovered of dockerDiscovery.data) {
      const discoveredContainerId = discovered.containerId.trim();
      if (!discoveredContainerId) {
        continue;
      }

      const existingIndex = configuredServices.findIndex(
        (configured) => configured.type === "docker" && configured.containerId.trim() === discoveredContainerId,
      );

      if (existingIndex >= 0) {
        const existing = configuredServices[existingIndex] as Extract<Service, { type: "docker" }>;
        // Update system fields from live discovery; preserve user customizations
        existing.containerName = discovered.containerName;
        existing.url = discovered.url;
        if (!existing.name || existing.name === discovered.containerId) {
          existing.name = discovered.name;
        }
        if (!existing.icon) {
          existing.icon = discovered.icon;
        }
        configChanged = true;
      } else {
        configuredServices.push(discovered);
        configChanged = true;
      }
    }

    if (configChanged) {
      await saveConfiguredState();
    }

    rebuildActiveServices();
  }

  await refreshDockerDiscoveredServices();

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
    title: ALL_SERVICES_TITLE,
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
    justifyContent: "space-between",
    alignItems: "center",
  });

  const footerText = new TextRenderable(renderer, {
    id: "footer-text",
    content: "",
    fg: COLORS.muted,
  });

  const footerAggregateText = new TextRenderable(renderer, {
    id: "footer-aggregate-text",
    content: "",
    fg: COLORS.muted,
  });

  footer.add(footerText);
  footer.add(footerAggregateText);

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

  const rowTexts: BoxRenderable[] = [];
  const cardHeaderBoxes: BoxRenderable[] = [];
  const cardIconTexts: TextRenderable[] = [];
  const cardStatusTexts: TextRenderable[] = [];
  const cardBottomTexts: TextRenderable[] = [];

  let cardSlotCounter = 0;

  function createCardSlot(): void {
    const slotId = cardSlotCounter++;

    const row = new BoxRenderable(renderer, {
      id: `service-row-${slotId}`,
      width: "48%",
      height: CARD_HEIGHT,
      padding: 1,
      border: true,
      flexDirection: "column",
      justifyContent: "space-between",
      backgroundColor: COLORS.cardBg,
      borderColor: COLORS.cardBorder,
    });

    const header = new BoxRenderable(renderer, {
      id: `service-header-${slotId}`,
      width: "100%",
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    });

    const icon = new TextRenderable(renderer, {
      id: `service-icon-${slotId}`,
      content: "",
    });

    const status = new TextRenderable(renderer, {
      id: `service-status-${slotId}`,
      content: "",
    });

    const bottom = new TextRenderable(renderer, {
      id: `service-bottom-${slotId}`,
      content: "",
      fg: COLORS.text,
    });

    row.add(header);
    header.add(icon);
    header.add(status);
    row.add(bottom);
    cardsGrid.add(row);

    rowTexts.push(row);
    cardHeaderBoxes.push(header);
    cardIconTexts.push(icon);
    cardStatusTexts.push(status);
    cardBottomTexts.push(bottom);
  }

  function removeCardSlot(index: number): void {
    const row = rowTexts[index];
    if (row) {
      cardsGrid.remove(row.id);
    }

    rowTexts.splice(index, 1);
    cardHeaderBoxes.splice(index, 1);
    cardIconTexts.splice(index, 1);
    cardStatusTexts.splice(index, 1);
    cardBottomTexts.splice(index, 1);
  }

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

  const detailsWidgetContent = new TextRenderable(renderer, {
    id: "details-widget-content",
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

  const searchEmptyState = new TextRenderable(renderer, {
    id: "search-empty-state",
    content: "",
    fg: COLORS.muted,
  });
  cardsViewport.add(searchEmptyState);

  detailsPanel.add(detailsTitle);
  detailsPanel.add(detailsUrl);
  detailsPanel.add(detailsHealth);
  detailsPanel.add(detailsChecked);
  detailsPanel.add(detailsError);
  detailsPanel.add(detailsRuntime);
  detailsPanel.add(detailsCpu);
  detailsPanel.add(detailsRam);
  detailsPanel.add(detailsDisk);
  detailsPanel.add(detailsWidgetContent);

  const health: ServiceHealth[] = [];
  const runtimeStats: ServiceRuntimeStats[] = [];
  let selectedIndex = 0;
  let scrollRowOffset = 0;
  let currentView: ServiceListView = { kind: "all" };

  function syncStateWithServices(): void {
    while (rowTexts.length < services.length) {
      createCardSlot();
    }

    while (rowTexts.length > services.length) {
      removeCardSlot(rowTexts.length - 1);
    }

    while (health.length < services.length) {
      health.push(createInitialHealth());
    }

    if (health.length > services.length) {
      health.splice(services.length);
    }

    while (runtimeStats.length < services.length) {
      runtimeStats.push(createInitialRuntimeStats());
    }

    if (runtimeStats.length > services.length) {
      runtimeStats.splice(services.length);
    }

    if (services.length === 0) {
      selectedIndex = 0;
      return;
    }

    if (selectedIndex >= services.length) {
      selectedIndex = services.length - 1;
    }
  }

  syncStateWithServices();

  function getViewCycleOrder(): ServiceListView[] {
    const groupNames = getDistinctGroupNames(services);
    const groupViews = groupNames.map<ServiceListView>((groupName) => ({
      kind: "group",
      groupName,
    }));
    return [{ kind: "all" }, ...groupViews];
  }

  function normalizeView(): void {
    if (currentView.kind === "all") {
      return;
    }

    const exists = getDistinctGroupNames(services).includes(currentView.groupName);
    if (!exists) {
      currentView = { kind: "all" };
    }
  }

  function getActiveServiceIndexes(): number[] {
    if (isSearchMode) {
      if (!searchQuery.trim()) {
        return services.map((_, i) => i);
      }
      return services
        .map((service, index) => ({ service, index }))
        .filter(({ service }) => fuzzyMatchService(searchQuery, service))
        .map(({ index }) => index);
    }

    normalizeView();

    const ordered = getServicesForView(services, currentView);
    const byService = new Map(services.map((service, index) => [service, index] as const));
    return ordered
      .map((service) => byService.get(service))
      .filter((index): index is number => index !== undefined);
  }

  function getCurrentServicesPanelTitle(): string {
    if (currentView.kind === "all") {
      return ALL_SERVICES_TITLE;
    }

    return `Group: ${currentView.groupName}`;
  }

  function ensureSelectionWithinActive(activeIndexes: number[]): void {
    if (activeIndexes.length === 0) {
      selectedIndex = 0;
      scrollRowOffset = 0;
      return;
    }

    if (!activeIndexes.includes(selectedIndex)) {
      selectedIndex = activeIndexes[0];
      scrollRowOffset = 0;
    }
  }

  function moveSelection(delta: number): void {
    const activeIndexes = getActiveServiceIndexes();
    if (activeIndexes.length === 0) {
      return;
    }

    ensureSelectionWithinActive(activeIndexes);

    const currentPosition = activeIndexes.indexOf(selectedIndex);
    const nextPosition = (currentPosition + delta + activeIndexes.length) % activeIndexes.length;
    selectedIndex = activeIndexes[nextPosition];
  }

  function cycleServiceView(): void {
    const order = getViewCycleOrder();

    const currentPosition = order.findIndex((view) => {
      if (view.kind !== currentView.kind) {
        return false;
      }

      if (view.kind === "all" && currentView.kind === "all") {
        return true;
      }

      if (view.kind === "group" && currentView.kind === "group") {
        return view.groupName === currentView.groupName;
      }

      return false;
    });

    const from = currentPosition >= 0 ? currentPosition : 0;
    const next = (from + 1) % order.length;
    currentView = order[next];

    ensureSelectionWithinActive(getActiveServiceIndexes());
  }

  let isFormActive = false;
  const formFields = {
    group: "",
    serviceName: "",
    url: "",
    icon: ICON_PRESETS[0],
  };
  let groupOptionIndex = -1;
  let iconOptionIndex = 0;
  let focusedFieldIndex = 0;
  let formError = "";
  let isSubmitting = false;
  let formMode: "add" | "edit" = "add";
  let editingIndex = -1;

  let isSettingsFormActive = false;
  const settingsFormFields = {
    autoRefreshEnabled: globalSettings.autoRefreshEnabled,
    autoRefreshIntervalSec: String(globalSettings.autoRefreshIntervalSec),
    selectedAutoRefreshIntervalSec: String(globalSettings.selectedAutoRefreshIntervalSec),
    autoRefreshDockerDiscovery: globalSettings.autoRefreshDockerDiscovery,
    refreshOnStart: globalSettings.refreshOnStart,
  };
  let settingsFocusedFieldIndex = 0;
  let settingsFormError = "";
  let isSettingsSubmitting = false;

  let isSearchMode = false;
  let searchQuery = "";

  let isWidgetPickerActive = false;
  let widgetPickerIndex = 0;

  let isWidgetFormActive = false;
  let widgetFormType = "";
  let widgetFormMode: "add" | "edit" = "add";
  let widgetEditingIndex = -1;
  let widgetFormFields: Record<string, string> = {};
  let widgetFormFocusedIndex = 0;
  let widgetFormError = "";
  let isWidgetSubmitting = false;

  interface WidgetDataState {
    state: "ok" | "error" | "loading";
    data?: unknown;
    error?: string;
    lastFetchedAt: number | null;
  }

  const widgetData: Map<number, WidgetDataState> = new Map();

  function resetSettingsForm(): void {
    settingsFormFields.autoRefreshEnabled = globalSettings.autoRefreshEnabled;
    settingsFormFields.autoRefreshIntervalSec = String(globalSettings.autoRefreshIntervalSec);
    settingsFormFields.selectedAutoRefreshIntervalSec = String(globalSettings.selectedAutoRefreshIntervalSec);
    settingsFormFields.autoRefreshDockerDiscovery = globalSettings.autoRefreshDockerDiscovery;
    settingsFormFields.refreshOnStart = globalSettings.refreshOnStart;
    settingsFocusedFieldIndex = 0;
    settingsFormError = "";
  }

  function startSettingsForm(): void {
    resetSettingsForm();
    isSettingsFormActive = true;
  }

  function settingsToggleLabel(value: boolean): string {
    return value ? "On" : "Off";
  }

  function toggleFocusedSettingBoolean(direction: 1 | -1 = 1): void {
    if (settingsFocusedFieldIndex === 0) {
      settingsFormFields.autoRefreshEnabled = direction > 0 ? true : false;
      return;
    }

    if (settingsFocusedFieldIndex === 3) {
      settingsFormFields.autoRefreshDockerDiscovery = direction > 0 ? true : false;
      return;
    }

    if (settingsFocusedFieldIndex === 4) {
      settingsFormFields.refreshOnStart = direction > 0 ? true : false;
    }
  }

  function settingsFieldLine(label: string, value: string, focused: boolean, panelWidth: number): string {
    return formFieldLine(label, value, focused, panelWidth);
  }

  function nextSettingsField(): void {
    const max = 5;
    settingsFocusedFieldIndex = (settingsFocusedFieldIndex + 1) % (max + 1);
  }

  function prevSettingsField(): void {
    const max = 5;
    settingsFocusedFieldIndex = (settingsFocusedFieldIndex - 1 + max + 1) % (max + 1);
  }

  async function submitSettingsForm(): Promise<void> {
    if (isSettingsSubmitting) {
      return;
    }

    isSettingsSubmitting = true;

    try {
      const parsedInterval = Number(settingsFormFields.autoRefreshIntervalSec.trim());
      if (!Number.isFinite(parsedInterval) || parsedInterval <= 0) {
        settingsFormError = "Error: Interval must be a positive number of seconds.";
        safeRender();
        return;
      }

      const parsedSelectedInterval = Number(settingsFormFields.selectedAutoRefreshIntervalSec.trim());
      if (!Number.isFinite(parsedSelectedInterval) || parsedSelectedInterval <= 0) {
        settingsFormError = "Error: Selected service interval must be a positive number of seconds.";
        safeRender();
        return;
      }

      const roundedInterval = Math.max(1, Math.round(parsedInterval));
      const roundedSelectedInterval = Math.max(1, Math.round(parsedSelectedInterval));

      globalSettings.autoRefreshEnabled = settingsFormFields.autoRefreshEnabled;
      globalSettings.autoRefreshIntervalSec = roundedInterval;
      globalSettings.selectedAutoRefreshIntervalSec = roundedSelectedInterval;
      globalSettings.autoRefreshDockerDiscovery = settingsFormFields.autoRefreshDockerDiscovery;
      globalSettings.refreshOnStart = settingsFormFields.refreshOnStart;

      await saveConfiguredState();
      configureHealthInterval();

      isSettingsFormActive = false;
      settingsFormError = "";
      safeRender();
    } finally {
      isSettingsSubmitting = false;
    }
  }

  function syncGroupOptionIndex(): void {
    const groups = getDistinctGroupNames(services);
    const group = formFields.group.trim();

    if (!group) {
      groupOptionIndex = -1;
      return;
    }

    groupOptionIndex = groups.findIndex((existing) => existing === group);
  }

  function cycleGroupOption(direction: 1 | -1): void {
    const groups = getDistinctGroupNames(services);
    if (groups.length === 0) {
      return;
    }

    const fromIndex = groupOptionIndex >= 0 ? groupOptionIndex : direction > 0 ? -1 : 0;
    const toIndex = (fromIndex + direction + groups.length) % groups.length;

    groupOptionIndex = toIndex;
    formFields.group = groups[toIndex];
  }

  function syncIconOptionIndex(): void {
    iconOptionIndex = ICON_PRESETS.findIndex((preset) => preset === formFields.icon);
  }

  function cycleIconOption(direction: 1 | -1): void {
    if (ICON_PRESETS.length === 0) {
      return;
    }

    const fromIndex = iconOptionIndex >= 0 ? iconOptionIndex : direction > 0 ? -1 : 0;
    const toIndex = (fromIndex + direction + ICON_PRESETS.length) % ICON_PRESETS.length;

    iconOptionIndex = toIndex;
    formFields.icon = ICON_PRESETS[toIndex];
  }

  function groupDisplayValue(): string {
    const trimmed = formFields.group.trim();
    const groups = getDistinctGroupNames(services);

    if (!trimmed) {
      return groups.length > 0 ? "(none) ←/→ existing" : "(none)";
    }

    if (groupOptionIndex >= 0 && groups[groupOptionIndex] === trimmed) {
      return `${trimmed} (${groupOptionIndex + 1}/${groups.length})`;
    }

    return `${trimmed} (new)`;
  }

  function resetForm() {
    formFields.group = "";
    formFields.serviceName = "";
    formFields.url = "";
    formFields.icon = ICON_PRESETS[0];
    groupOptionIndex = -1;
    iconOptionIndex = 0;
    focusedFieldIndex = 0;
    formError = "";
    formMode = "add";
    editingIndex = -1;
  }

  function startEditForm(index: number) {
    const service = services[index];
    formFields.group = (service.group ?? "").trim();
    formFields.serviceName = service.name;
    formFields.url = service.url;
    formFields.icon = service.icon ?? ICON_PRESETS[0];
    syncGroupOptionIndex();
    syncIconOptionIndex();
    focusedFieldIndex = 0;
    formError = "";
    formMode = "edit";
    editingIndex = index;
    isSettingsFormActive = false;
    isFormActive = true;
  }

  function iconDisplayValue(): string {
    const trimmed = formFields.icon.trim();
    if (!trimmed) {
      return ICON_PRESETS.length > 0 ? `(none) ←/→ presets` : "(none)";
    }

    if (iconOptionIndex >= 0 && ICON_PRESETS[iconOptionIndex] === formFields.icon) {
      return `${formFields.icon} (${iconOptionIndex + 1}/${ICON_PRESETS.length})`;
    }

    return `${formFields.icon} (custom)`;
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

      const normalizedGroup = formFields.group.trim();

      if (formMode === "edit" && editingIndex >= 0) {
        const existing = services[editingIndex];
        if (!existing) {
          formError = "Error: Service no longer exists.";
          safeRender();
          return;
        }

        Object.assign(existing, {
          name: capitalizeFirstLetter(formFields.serviceName),
          url: formFields.url.trim(),
          group: normalizedGroup || undefined,
          icon: formFields.icon.trim() || ICON_PRESETS[0],
        });

        await saveConfiguredState();

        isFormActive = false;
        formError = "";
        selectedIndex = editingIndex;
        syncStateWithServices();
        safeRender();

        void refreshServiceAndDetectContainer(editingIndex).then(() => {
          safeRender();
        });
        return;
      }

      const newService: ManualService = {
        type: "manual",
        name: capitalizeFirstLetter(formFields.serviceName),
        url: formFields.url.trim(),
        group: normalizedGroup || undefined,
        icon: formFields.icon.trim() || ICON_PRESETS[0],
      };

      const firstDockerIndex = services.findIndex((service) => service.type === "docker");
      const insertIndex = firstDockerIndex >= 0 ? firstDockerIndex : services.length;
      configuredServices.push(newService);
      services.splice(insertIndex, 0, newService);
      await saveConfiguredState();

      isFormActive = false;
      selectedIndex = insertIndex;
      formError = "";
      syncStateWithServices();
      safeRender();

      void refreshServiceAndDetectContainer(insertIndex).then(() => {
        safeRender();
      });
    } finally {
      isSubmitting = false;
    }
  }

  async function deleteService(index: number) {
    if (index < 0 || index >= services.length) return;

    const service = services[index];
    if (!service) {
      return;
    }

    const configuredIndex = configuredServices.indexOf(service);
    if (configuredIndex >= 0) {
      configuredServices.splice(configuredIndex, 1);
    }
    services.splice(index, 1);
    widgetData.clear();
    await saveConfiguredState();

    syncStateWithServices();

    if (services.length === 0) {
      selectedIndex = 0;
    } else if (selectedIndex > index) {
      selectedIndex--;
    } else if (selectedIndex >= services.length) {
      selectedIndex = services.length - 1;
    }

    safeRender();
  }


  function getWidgetFormFieldList(widgetDef: WidgetDefinition): Array<{ kind: "service"; label: string; name: string; type: string } | { kind: "widget"; field: WidgetField }> {
    return [
      { kind: "service" as const, label: "Name", name: "name", type: "text" },
      { kind: "service" as const, label: "URL", name: "url", type: "text" },
      { kind: "service" as const, label: "Group", name: "group", type: "text" },
      { kind: "service" as const, label: "Icon", name: "icon", type: "text" },
      ...widgetDef.fields.map((field) => ({ kind: "widget" as const, field })),
    ];
  }

  function resetWidgetForm(type: string): void {
    const def = getWidgetById(type);
    widgetFormType = type;
    widgetFormFields = {
      name: "",
      url: "",
      group: "",
      icon: def?.icon ?? "•",
    };
    if (def) {
      for (const field of def.fields) {
        widgetFormFields[field.name] = "";
      }
    }
    widgetFormFocusedIndex = 0;
    widgetFormError = "";
    widgetFormMode = "add";
    widgetEditingIndex = -1;
  }

  function startWidgetEditForm(index: number): void {
    const service = services[index];
    if (service.type !== "widget") return;
    const ws = service as WidgetService;
    const def = getWidgetById(ws.widgetType);
    widgetFormType = ws.widgetType;
    widgetFormFields = {
      name: ws.name,
      url: ws.url,
      group: (ws.group ?? "").trim(),
      icon: ws.icon ?? def?.icon ?? "•",
    };
    if (def) {
      for (const field of def.fields) {
        widgetFormFields[field.name] = ws.widgetConfig[field.name] ?? "";
      }
    }
    widgetFormFocusedIndex = 0;
    widgetFormError = "";
    widgetFormMode = "edit";
    widgetEditingIndex = index;
  }

  async function submitWidgetForm(): Promise<void> {
    if (isWidgetSubmitting) return;
    isWidgetSubmitting = true;

    try {
      const def = getWidgetById(widgetFormType);
      if (!def) {
        widgetFormError = "Error: Unknown widget type.";
        safeRender();
        return;
      }

      const name = widgetFormFields.name.trim();
      const url = widgetFormFields.url.trim();

      if (!name) {
        widgetFormError = "Error: Name is required.";
        safeRender();
        return;
      }
      if (!url) {
        widgetFormError = "Error: URL is required.";
        safeRender();
        return;
      }

      for (const field of def.fields) {
        if (field.required && !widgetFormFields[field.name]?.trim()) {
          widgetFormError = `Error: ${field.label} is required.`;
          safeRender();
          return;
        }
      }

      const widgetConfig: Record<string, string> = {};
      for (const field of def.fields) {
        widgetConfig[field.name] = widgetFormFields[field.name] ?? "";
      }

      const normalizedGroup = widgetFormFields.group.trim();

      if (widgetFormMode === "edit" && widgetEditingIndex >= 0) {
        const existing = services[widgetEditingIndex];
        if (!existing || existing.type !== "widget") {
          widgetFormError = "Error: Widget no longer exists.";
          safeRender();
          return;
        }
        Object.assign(existing, {
          name: capitalizeFirstLetter(name),
          url,
          group: normalizedGroup || undefined,
          icon: widgetFormFields.icon.trim() || def.icon,
          widgetType: widgetFormType,
          widgetConfig,
        });
        await saveConfiguredState();
        isWidgetFormActive = false;
        widgetFormError = "";
        selectedIndex = widgetEditingIndex;
        syncStateWithServices();
        safeRender();
        void refreshWidgetData(widgetEditingIndex);
        return;
      }

      const newWidget: WidgetService = {
        type: "widget",
        name: capitalizeFirstLetter(name),
        url,
        group: normalizedGroup || undefined,
        icon: widgetFormFields.icon.trim() || def.icon,
        widgetType: widgetFormType,
        widgetConfig,
      };

      configuredServices.push(newWidget);
      services.push(newWidget);
      await saveConfiguredState();

      const newIndex = services.length - 1;
      isWidgetFormActive = false;
      widgetFormError = "";
      selectedIndex = newIndex;
      syncStateWithServices();
      safeRender();
      void refreshWidgetData(newIndex);
    } finally {
      isWidgetSubmitting = false;
    }
  }

  async function refreshWidgetData(index: number): Promise<void> {
    const service = services[index];
    if (!service || service.type !== "widget") return;
    const ws = service as WidgetService;
    const def = getWidgetById(ws.widgetType);
    if (!def) return;

    widgetData.set(index, { state: "loading", lastFetchedAt: Date.now() });
    safeRender();

    try {
      const config = { ...ws.widgetConfig, url: ws.url };
      const data = await def.fetchData(config);
      widgetData.set(index, { state: "ok", data, lastFetchedAt: Date.now() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      widgetData.set(index, { state: "error", error: message, lastFetchedAt: Date.now() });
    }

    safeRender();
  }

  function renderWidgetDetail(index: number, width: number): string {
    const service = services[index];
    if (!service || service.type !== "widget") return "";
    const ws = service as WidgetService;
    const def = getWidgetById(ws.widgetType);
    if (!def) return "Unknown widget type";

    const data = widgetData.get(index);
    if (!data || data.state === "loading") {
      return "Loading widget data...";
    }
    if (data.state === "error") {
      return `Error: ${data.error ?? "Unknown error"}`;
    }

    const lines = def.render(data.data, width);
    return lines.join("\n");
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
    syncStateWithServices();

    const activeServiceIndexes = getActiveServiceIndexes();
    ensureSelectionWithinActive(activeServiceIndexes);
    servicesPanel.title = getCurrentServicesPanelTitle();

    if (isSearchMode) {
      servicesPanel.title = `Search: ${searchQuery || "..."}`;
    }

    for (const [slotIndex, row] of rowTexts.entries()) {
      const serviceIndex = activeServiceIndexes[slotIndex];

      if (serviceIndex === undefined) {
        row.width = 0;
        row.height = 0;
        row.padding = 0;
        row.border = false;
        cardIconTexts[slotIndex].content = "";
        cardStatusTexts[slotIndex].content = "";
        cardBottomTexts[slotIndex].content = "";
        continue;
      }

      row.width = "48%";
      row.height = CARD_HEIGHT;
      row.padding = 1;
      row.border = true;

      const service = services[serviceIndex];
      const rowHealth = health[serviceIndex];
      const icon = service.icon ?? "•";
      const name = truncate(capitalizeFirstLetter(service.name), 20);
      const description = service.description
        ? truncate(service.description, 30)
        : truncate(service.url, 30);
      const badge = statusText(rowHealth.state);
      const focused = serviceIndex === selectedIndex;

      const iconChunk = fg(COLORS.iconFg)(bg(COLORS.iconBg)(` ${icon} `));
      cardIconTexts[slotIndex].content = t`${iconChunk}`;

      const badgeColor = statusColor(rowHealth.state);
      cardStatusTexts[slotIndex].content = t`${fg(badgeColor)(`[ ${badge} ]`)}`;

      const nameColor = focused ? COLORS.focused : COLORS.text;
      cardBottomTexts[slotIndex].content = t`${bold(fg(nameColor)(name))}\n${fg(COLORS.muted)(description)}`;

      row.borderStyle = focused ? "double" : "single";
      row.borderColor = focused ? COLORS.cardBorderFocused : COLORS.cardBorder;
    }

    if (isSearchMode && activeServiceIndexes.length === 0) {
      searchEmptyState.content = `No services found for "${searchQuery}"\nPress Enter to search Google`;
    } else {
      searchEmptyState.content = "";
    }

    const activeSelectedPosition = activeServiceIndexes.indexOf(selectedIndex);
    const selectedRow = Math.floor(Math.max(0, activeSelectedPosition) / CARD_COLUMNS);
    const visibleRows = Math.max(1, Math.floor(cardsViewport.height / CARD_ROW_STRIDE));

    if (selectedRow < scrollRowOffset) {
      scrollRowOffset = selectedRow;
    } else if (selectedRow >= scrollRowOffset + visibleRows) {
      scrollRowOffset = selectedRow - visibleRows + 1;
    }

    cardsGrid.translateY = -(scrollRowOffset * CARD_ROW_STRIDE);

    const pw = detailsPanel.width;
    const contentWidth = Math.max(10, pw - 4);

    const aggregateCpuPercent = aggregateMetric(
      runtimeStats.map((stats) => (stats.state === "available" ? parsePercent(stats.cpuUsage) : null)),
    );
    const aggregateRamPercent = aggregateMetric(
      runtimeStats.map((stats) =>
        stats.state === "available"
          ? (parsePercent(stats.memoryPercent) ?? parseUsagePairPercent(stats.memoryUsage))
          : null,
      ),
    );
    const aggregateDiskPercent = aggregateMetric(
      runtimeStats.map((stats) => (stats.state === "available" ? diskSizePercent(stats.diskSizeBytes) : null)),
    );

    footerAggregateText.content = `CPU=${formatAggregatePercent(aggregateCpuPercent)}, RAM=${formatAggregatePercent(aggregateRamPercent)}, DISK=${formatAggregatePercent(aggregateDiskPercent)}`;

    if (isSettingsFormActive) {
      detailsPanel.title = "Global settings";

      const FIELDS = {
        autoRefreshEnabled: 0,
        autoRefreshIntervalSec: 1,
        selectedAutoRefreshIntervalSec: 2,
        autoRefreshDockerDiscovery: 3,
        refreshOnStart: 4,
        save: 5,
      };

      detailsTitle.content = "";
      detailsTitle.fg = COLORS.focused;

      const autoRefreshFocused = settingsFocusedFieldIndex === FIELDS.autoRefreshEnabled;
      detailsUrl.content = settingsFieldLine(
        "Auto refresh",
        `${settingsToggleLabel(settingsFormFields.autoRefreshEnabled)} (←/→)`,
        autoRefreshFocused,
        pw,
      );
      detailsUrl.fg = autoRefreshFocused ? COLORS.focused : COLORS.text;

      const intervalFocused = settingsFocusedFieldIndex === FIELDS.autoRefreshIntervalSec;
      detailsHealth.content = settingsFieldLine(
        "Interval sec",
        settingsFormFields.autoRefreshIntervalSec,
        intervalFocused,
        pw,
      );
      detailsHealth.fg = intervalFocused ? COLORS.focused : COLORS.text;

      const selectedIntervalFocused = settingsFocusedFieldIndex === FIELDS.selectedAutoRefreshIntervalSec;
      detailsChecked.content = settingsFieldLine(
        "Selected svc sec",
        settingsFormFields.selectedAutoRefreshIntervalSec,
        selectedIntervalFocused,
        pw,
      );
      detailsChecked.fg = selectedIntervalFocused ? COLORS.focused : COLORS.text;

      const dockerDiscoveryFocused = settingsFocusedFieldIndex === FIELDS.autoRefreshDockerDiscovery;
      detailsError.content = settingsFieldLine(
        "Auto Docker scan",
        `${settingsToggleLabel(settingsFormFields.autoRefreshDockerDiscovery)} (←/→)`,
        dockerDiscoveryFocused,
        pw,
      );
      detailsError.fg = dockerDiscoveryFocused ? COLORS.focused : COLORS.text;

      const refreshOnStartFocused = settingsFocusedFieldIndex === FIELDS.refreshOnStart;
      detailsRuntime.content = settingsFieldLine(
        "Refresh on start",
        `${settingsToggleLabel(settingsFormFields.refreshOnStart)} (←/→)`,
        refreshOnStartFocused,
        pw,
      );
      detailsRuntime.fg = refreshOnStartFocused ? COLORS.focused : COLORS.text;

      detailsCpu.content = "";
      detailsCpu.fg = COLORS.text;

      if (settingsFormError) {
        const errorPrefix = "Error: ";
        detailsRam.content =
          errorPrefix +
          truncate(settingsFormError.slice(errorPrefix.length), Math.max(3, contentWidth - errorPrefix.length));
        detailsRam.fg = COLORS.offline;
      } else {
        const saveFocused = settingsFocusedFieldIndex === FIELDS.save;
        detailsRam.content = `${saveFocused ? "> " : "  "}[Save]`;
        detailsRam.fg = saveFocused ? COLORS.focused : COLORS.muted;
      }

      detailsDisk.content = "";
      detailsDisk.fg = COLORS.text;
      detailsWidgetContent.content = "";

      footerText.content = "↑/↓ fields • ←/→ toggle • Type interval seconds • Enter save • Esc cancel";
    } else if (isFormActive) {
      detailsPanel.title = formMode === "edit" ? "Edit service" : "New service";

      const FIELDS = {
        serviceName: 0,
        url: 1,
        group: 2,
        icon: 3,
        save: 4,
      };

      detailsTitle.content = "";
      detailsTitle.fg = COLORS.focused;

      const serviceNameFocused = focusedFieldIndex === FIELDS.serviceName;
      detailsUrl.content = formFieldLine("Name", formFields.serviceName, serviceNameFocused, pw);
      detailsUrl.fg = serviceNameFocused ? COLORS.focused : COLORS.text;

      const urlFocused = focusedFieldIndex === FIELDS.url;
      detailsHealth.content = formFieldLine("URL", formFields.url, urlFocused, pw);
      detailsHealth.fg = urlFocused ? COLORS.focused : COLORS.text;

      const groupFocused = focusedFieldIndex === FIELDS.group;
      detailsChecked.content = formFieldLine("Group", groupDisplayValue(), groupFocused, pw);
      detailsChecked.fg = groupFocused ? COLORS.focused : COLORS.text;

      const iconFocused = focusedFieldIndex === FIELDS.icon;
      detailsError.content = formFieldLine("Icon", iconDisplayValue(), iconFocused, pw);
      detailsError.fg = iconFocused ? COLORS.focused : COLORS.text;

      detailsRuntime.content = "";
      detailsRuntime.fg = COLORS.text;

      detailsCpu.content = "";
      detailsCpu.fg = COLORS.text;

      if (formError) {
        const errorPrefix = "Error: ";
        detailsRam.content = errorPrefix + truncate(formError.slice(errorPrefix.length), Math.max(3, contentWidth - errorPrefix.length));
        detailsRam.fg = COLORS.offline;
      } else {
        const saveFocused = focusedFieldIndex === FIELDS.save;
        detailsRam.content = `${saveFocused ? "> " : "  "}[Save]`;
        detailsRam.fg = saveFocused ? COLORS.focused : COLORS.muted;
      }

      detailsDisk.content = "";
      detailsDisk.fg = COLORS.text;
      detailsWidgetContent.content = "";

      footerText.content = "↑/↓ fields • ←/→ group/icon presets • Type/paste name/url/group/icon • Enter save • Esc cancel";
    } else if (isSearchMode) {
      detailsPanel.title = "Search";

      detailsTitle.content = "🔍 Search Services";
      detailsTitle.fg = COLORS.focused;

      detailsUrl.content = formFieldLine("Query", searchQuery, true, pw);
      detailsUrl.fg = COLORS.focused;

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
      detailsWidgetContent.content = "";

      footerText.content = "Type to fuzzy search • Enter Google search • Esc cancel";
    } else if (isWidgetPickerActive) {
      detailsPanel.title = "Widgets";

      detailsTitle.content = "Select a widget:";
      detailsTitle.fg = COLORS.focused;

      const cardWidth = Math.max(14, contentWidth);
      const cards: string[] = [];

      for (let i = 0; i < WIDGET_REGISTRY.length; i++) {
        const w = WIDGET_REGISTRY[i];
        const focused = i === widgetPickerIndex;
        const topBorder = focused
          ? `╔${"═".repeat(Math.max(2, cardWidth - 2))}╗`
          : `┌${"─".repeat(Math.max(2, cardWidth - 2))}┐`;
        const bottomBorder = focused
          ? `╚${"═".repeat(Math.max(2, cardWidth - 2))}╝`
          : `└${"─".repeat(Math.max(2, cardWidth - 2))}┘`;
        const side = focused ? "║" : "│";
        const namePrefix = focused ? "▶ " : "  ";
        const nameLine = `${side}${namePrefix}${truncate(`${w.icon} ${w.name}`, cardWidth - 4).padEnd(cardWidth - 4)}${side}`;
        const descLine = `${side}  ${truncate(w.description, cardWidth - 4).padEnd(cardWidth - 4)}${side}`;

        cards.push(topBorder);
        cards.push(nameLine);
        cards.push(descLine);
        cards.push(bottomBorder);
        if (i < WIDGET_REGISTRY.length - 1) {
          cards.push("");
        }
      }

      detailsUrl.content = cards.join("\n");
      detailsUrl.fg = COLORS.text;

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
      detailsWidgetContent.content = "";

      footerText.content = "↑/↓ navigate • Enter select • Esc cancel";
    } else if (isWidgetFormActive) {
      const def = getWidgetById(widgetFormType);
      detailsPanel.title = def ? `${widgetFormMode === "edit" ? "Edit" : "New"} ${def.name}` : "Widget";

      const fields = def ? getWidgetFormFieldList(def) : [];

      detailsTitle.content = "";
      detailsTitle.fg = COLORS.focused;

      const lines: string[] = [];
      const fgLines: string[] = [];

      for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        const focused = i === widgetFormFocusedIndex;
        if (field.kind === "service") {
          let value = widgetFormFields[field.name] ?? "";
          if (field.name === "group") {
            const groups = getDistinctGroupNames(services);
            if (!value.trim()) {
              value = groups.length > 0 ? "(none) ←/→ existing" : "(none)";
            } else {
              const idx = groups.indexOf(value);
              if (idx >= 0) {
                value = `${value} (${idx + 1}/${groups.length})`;
              } else {
                value = `${value} (new)`;
              }
            }
          }
          lines.push(formFieldLine(field.label, value, focused, pw));
        } else {
          const value = widgetFormFields[field.field.name] ?? "";
          lines.push(formFieldLine(field.field.label, value, focused, pw));
        }
        fgLines.push(focused ? COLORS.focused : COLORS.text);
      }

      detailsUrl.content = lines[0] ?? "";
      detailsUrl.fg = fgLines[0] ?? COLORS.text;
      detailsHealth.content = lines[1] ?? "";
      detailsHealth.fg = fgLines[1] ?? COLORS.text;
      detailsChecked.content = lines[2] ?? "";
      detailsChecked.fg = fgLines[2] ?? COLORS.text;
      detailsError.content = lines[3] ?? "";
      detailsError.fg = fgLines[3] ?? COLORS.text;

      let lineIdx = 4;
      detailsRuntime.content = lines[lineIdx] ?? "";
      detailsRuntime.fg = fgLines[lineIdx] ?? COLORS.text;
      lineIdx++;
      detailsCpu.content = lines[lineIdx] ?? "";
      detailsCpu.fg = fgLines[lineIdx] ?? COLORS.text;
      lineIdx++;
      detailsRam.content = "";
      detailsRam.fg = COLORS.text;
      lineIdx++;
      detailsDisk.content = lines[lineIdx] ?? "";
      detailsDisk.fg = fgLines[lineIdx] ?? COLORS.text;
      lineIdx++;

      // If more widget fields exist, render them into widget content
      if (lineIdx < lines.length) {
        detailsWidgetContent.content = "\n" + lines.slice(lineIdx).join("\n");
      } else {
        detailsWidgetContent.content = "";
      }

      if (widgetFormError) {
        const errorPrefix = "Error: ";
        detailsRam.content =
          errorPrefix +
          truncate(widgetFormError.slice(errorPrefix.length), Math.max(3, contentWidth - errorPrefix.length));
        detailsRam.fg = COLORS.offline;
      } else {
        const saveFocused = widgetFormFocusedIndex === fields.length;
        detailsRam.content = `${saveFocused ? "> " : "  "}[Save]`;
        detailsRam.fg = saveFocused ? COLORS.focused : COLORS.muted;
      }

      footerText.content = "↑/↓ fields • ←/→ group/icon presets • Type to edit • Enter save • Esc cancel";
    } else if (activeServiceIndexes.length === 0) {
      detailsPanel.title = "Details";

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
      detailsWidgetContent.content = "";

      footerText.content = "n new service • w widgets • s settings • f search • t toggle view • r refresh • Ctrl+C quit";
    } else {
      const selected = services[selectedIndex];

      detailsPanel.title = truncate(capitalizeFirstLetter(selected.name), Math.max(3, pw - 4));

      const titlePrefix = `${selected.icon ?? "•"} `;
      detailsTitle.content =
        titlePrefix + truncate(capitalizeFirstLetter(selected.name), Math.max(3, contentWidth - titlePrefix.length));
      detailsTitle.fg = COLORS.focused;

      const urlPrefix = "URL: ";
      detailsUrl.content = urlPrefix + truncate(selected.url, Math.max(3, contentWidth - urlPrefix.length));
      detailsUrl.fg = COLORS.text;

      if (selected.type === "widget") {
        const ws = selected as WidgetService;
        const def = getWidgetById(ws.widgetType);

        detailsHealth.content = `Type: widget (${def?.name ?? ws.widgetType})`;
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

        const widgetContent = renderWidgetDetail(selectedIndex, pw);
        detailsWidgetContent.content = widgetContent ? "\n" + widgetContent : "";

        footerText.content = `←/→/↑/↓ navigate • t toggle view • n new • s settings • f search • w widgets • e edit • d delete • r refresh • Ctrl+C quit`;
      } else {
        const selectedHealth = health[selectedIndex];
        const selectedRuntime = runtimeStats[selectedIndex];

        const healthPrefix = "Health: ";
        const healthText = statusText(selectedHealth.state);
        detailsHealth.content = healthPrefix + healthText;
        detailsHealth.fg = statusColor(selectedHealth.state);

        const typePrefix = "Type: ";
        detailsChecked.content = typePrefix + selected.type;
        detailsChecked.fg = COLORS.text;

        const groupPrefix = "Group: ";
        const groupValue = isUngroupedService(selected) ? "ungrouped" : getServiceGroupLabel(selected).toLowerCase();
        detailsError.content = groupPrefix + groupValue;
        detailsError.fg = COLORS.text;

        const runtimePrefix = "Runtime: ";

        if (selectedRuntime.state === "available") {
          const runtimeLabel = selectedRuntime.containerName
            ? `Docker (${selectedRuntime.containerName})`
            : "Docker";
          detailsRuntime.content = "\n" + runtimePrefix + truncate(runtimeLabel, Math.max(3, contentWidth - runtimePrefix.length));
          detailsRuntime.fg = COLORS.text;

          const cpuPercent = parsePercent(selectedRuntime.cpuUsage);
          detailsCpu.content = `\n${renderMetricBar("CPU", selectedRuntime.cpuUsage ?? "-", cpuPercent, pw)}`;
          detailsCpu.fg = metricColor(cpuPercent);

          const ramPercent = parsePercent(selectedRuntime.memoryPercent) ?? parseUsagePairPercent(selectedRuntime.memoryUsage);
          const ramUsedValue = usagePairUsedValue(selectedRuntime.memoryUsage);
          detailsRam.content = `\n${renderMetricBar("RAM", ramUsedValue, ramPercent, pw)}`;
          detailsRam.fg = metricColor(ramPercent);

          const diskPercent = diskSizePercent(selectedRuntime.diskSizeBytes);
          detailsDisk.content = `\n${renderMetricBar("Disk", selectedRuntime.diskSize ?? "-", diskPercent, pw)}`;
          detailsDisk.fg = metricColor(diskPercent);
        } else if (selectedRuntime.state === "not-applicable") {
          detailsRuntime.content = "";
          detailsRuntime.fg = COLORS.text;

          detailsCpu.content = "";
          detailsCpu.fg = COLORS.text;
          detailsRam.content = "";
          detailsRam.fg = COLORS.text;
          detailsDisk.content = "";
          detailsDisk.fg = COLORS.text;
        } else if (selectedRuntime.state === "unavailable") {
          const runtimeMessage =
            selectedRuntime.errorCode === "CONTAINER_NOT_FOUND"
              ? "No container linked"
              : selectedRuntime.errorCode === "DOCKER_DAEMON_UNAVAILABLE" || selectedRuntime.errorCode === "DOCKER_NOT_INSTALLED"
                ? "Docker unavailable"
                : "Docker runtime unavailable";

          detailsRuntime.content = "\n" + runtimePrefix + truncate(runtimeMessage, Math.max(3, contentWidth - runtimePrefix.length));
          detailsRuntime.fg = COLORS.offline;

          detailsCpu.content = "\nCPU: -";
          detailsCpu.fg = COLORS.muted;
          detailsRam.content = "\nRAM: -";
          detailsRam.fg = COLORS.muted;
          detailsDisk.content = "\nDisk: -";
          detailsDisk.fg = COLORS.muted;
        } else {
          detailsRuntime.content = "";
          detailsRuntime.fg = COLORS.text;

          detailsCpu.content = "";
          detailsCpu.fg = COLORS.text;
          detailsRam.content = "";
          detailsRam.fg = COLORS.text;
          detailsDisk.content = "";
          detailsDisk.fg = COLORS.text;
        }

        detailsWidgetContent.content = "";

        footerText.content = `←/→/↑/↓ navigate • t toggle view • n new • s settings • f search • w widgets • Enter open • e edit • d delete • r refresh • Ctrl+C quit`;
      }
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
        memoryPercent: runtimeResult.data.stats.memoryPercent,
        diskSize: runtimeResult.data.stats.diskSize,
        diskSizeBytes: runtimeResult.data.stats.diskSizeBytes,
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
        memoryPercent: null,
        diskSize: null,
        diskSizeBytes: null,
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
      memoryPercent: null,
      diskSize: null,
      diskSizeBytes: null,
      lastCheckedAt: Date.now(),
      errorCode: runtimeResult.error.code,
      errorDetails: runtimeResult.error.details ?? runtimeResult.error.message,
    };
  };

  const detectAndPersistServiceContainer = async (index: number): Promise<void> => {
    const service = services[index];
    if (!service || service.type !== "manual") {
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
      (service as ManualService & { containerId?: string; containerName?: string }).containerId !== nextContainerId ||
      (service as ManualService & { containerId?: string; containerName?: string }).containerName !== nextContainerName;

    if (!hasChanges) {
      return;
    }

    (service as ManualService & { containerId?: string; containerName?: string }).containerId = nextContainerId;
    (service as ManualService & { containerId?: string; containerName?: string }).containerName = nextContainerName;
    await saveConfiguredState();
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

  const refreshHealth = async (withDockerDiscovery = false) => {
    if (stopped) {
      return;
    }

    if (withDockerDiscovery) {
      await refreshDockerDiscoveredServices();
      syncStateWithServices();
    }

    await Promise.all(services.map((_, index) => refreshServiceState(index)));

    if (stopped) {
      return;
    }

    // Refresh widget data for visible widget services
    for (let i = 0; i < services.length; i++) {
      if (services[i].type === "widget") {
        const data = widgetData.get(i);
        const shouldRefresh = !data || !data.lastFetchedAt || (Date.now() - data.lastFetchedAt > 30_000);
        if (shouldRefresh) {
          void refreshWidgetData(i);
        }
      }
    }

    safeRender();
  };

  let healthTimeout: ReturnType<typeof setTimeout> | null = null;

  function getCurrentRefreshIntervalMs(): number {
    if (!globalSettings.autoRefreshEnabled) {
      return 0;
    }

    const isServiceView = !isSettingsFormActive && !isFormActive && !isSearchMode && !isWidgetPickerActive && !isWidgetFormActive && services.length > 0;
    if (isServiceView) {
      return Math.max(1_000, globalSettings.selectedAutoRefreshIntervalSec * 1_000);
    }

    return Math.max(1_000, globalSettings.autoRefreshIntervalSec * 1_000);
  }

  function configureHealthInterval(): void {
    if (healthTimeout) {
      clearTimeout(healthTimeout);
      healthTimeout = null;
    }

    const intervalMs = getCurrentRefreshIntervalMs();
    if (intervalMs === 0) {
      return;
    }

    healthTimeout = setTimeout(() => {
      void refreshHealth(globalSettings.autoRefreshDockerDiscovery)
        .then(() => configureHealthInterval())
        .catch(() => configureHealthInterval());
    }, intervalMs);
  }

  safeRender();
  configureHealthInterval();

  const relativeInterval = setInterval(() => {
    safeRender();
  }, 1_000);

  if (globalSettings.refreshOnStart) {
    void refreshHealth(globalSettings.autoRefreshDockerDiscovery);
  }

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (healthTimeout) {
      clearTimeout(healthTimeout);
      healthTimeout = null;
    }
    clearInterval(relativeInterval);
    renderer.destroy();
  };

  const exitGracefully = () => {
    stop();
    process.exit(0);
  };

  const failFast = (error: unknown, context: string): never => {
    const message = error instanceof Error ? error.message : String(error);
    stop();
    console.error(`homestat ${context}: ${message}`);
    process.exit(1);
  };

  const isTextField = (index: number): boolean => index === 0 || index === 1 || index === 2 || index === 3;

  const appendTextToFocusedField = (rawText: string): void => {
    const normalized = rawText.replace(/[\r\n]+/g, "");
    if (!normalized) {
      return;
    }

    if (focusedFieldIndex === 0) {
      formFields.serviceName += normalized;
      return;
    }

    if (focusedFieldIndex === 1) {
      formFields.url += normalized;
      return;
    }

    if (focusedFieldIndex === 2) {
      formFields.group += normalized;
      syncGroupOptionIndex();
      return;
    }

    if (focusedFieldIndex === 3) {
      const isPresetSelected = iconOptionIndex >= 0 && ICON_PRESETS[iconOptionIndex] === formFields.icon;
      formFields.icon = isPresetSelected ? normalized : `${formFields.icon}${normalized}`;
      syncIconOptionIndex();
      return;
    }
  };

  const nextField = (): void => {
    const max = 4;
    focusedFieldIndex = (focusedFieldIndex + 1) % (max + 1);
  };

  const prevField = (): void => {
    const max = 4;
    focusedFieldIndex = (focusedFieldIndex - 1 + max + 1) % (max + 1);
  };

  const textDecoder = new TextDecoder();

  renderer.keyInput.on("keypress", (event: KeyEvent) => {
    if (event.ctrl && event.name === "c") {
      event.preventDefault();
      exitGracefully();
      return;
    }

    if (isSettingsFormActive) {
      settingsFormError = "";

      if (event.name === "escape") {
        isSettingsFormActive = false;
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "up") {
        prevSettingsField();
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "down") {
        nextSettingsField();
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "left") {
        toggleFocusedSettingBoolean(-1);
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "right") {
        toggleFocusedSettingBoolean(1);
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "space") {
        if (settingsFocusedFieldIndex === 0) {
          settingsFormFields.autoRefreshEnabled = !settingsFormFields.autoRefreshEnabled;
          safeRender();
        } else if (settingsFocusedFieldIndex === 3) {
          settingsFormFields.autoRefreshDockerDiscovery = !settingsFormFields.autoRefreshDockerDiscovery;
          safeRender();
        } else if (settingsFocusedFieldIndex === 4) {
          settingsFormFields.refreshOnStart = !settingsFormFields.refreshOnStart;
          safeRender();
        }
        event.preventDefault();
        return;
      }

      if (event.name === "return" || event.name === "enter") {
        if (settingsFocusedFieldIndex === 5) {
          void submitSettingsForm();
          event.preventDefault();
          return;
        }

        if (settingsFocusedFieldIndex === 0 || settingsFocusedFieldIndex === 3 || settingsFocusedFieldIndex === 4) {
          toggleFocusedSettingBoolean(1);
          safeRender();
          event.preventDefault();
          return;
        }
      }

      if (settingsFocusedFieldIndex === 1 && event.name === "backspace") {
        settingsFormFields.autoRefreshIntervalSec = settingsFormFields.autoRefreshIntervalSec.slice(0, -1);
        safeRender();
        event.preventDefault();
        return;
      }

      if (settingsFocusedFieldIndex === 2 && event.name === "backspace") {
        settingsFormFields.selectedAutoRefreshIntervalSec = settingsFormFields.selectedAutoRefreshIntervalSec.slice(0, -1);
        safeRender();
        event.preventDefault();
        return;
      }

      if (
        settingsFocusedFieldIndex === 1 &&
        event.sequence &&
        !event.ctrl &&
        !event.meta &&
        /^[0-9]$/.test(event.sequence)
      ) {
        settingsFormFields.autoRefreshIntervalSec += event.sequence;
        safeRender();
        event.preventDefault();
        return;
      }

      if (
        settingsFocusedFieldIndex === 2 &&
        event.sequence &&
        !event.ctrl &&
        !event.meta &&
        /^[0-9]$/.test(event.sequence)
      ) {
        settingsFormFields.selectedAutoRefreshIntervalSec += event.sequence;
        safeRender();
        event.preventDefault();
        return;
      }

      event.preventDefault();
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

      if (event.name === "left" && focusedFieldIndex === 2) {
        cycleGroupOption(-1);
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "right" && focusedFieldIndex === 2) {
        cycleGroupOption(1);
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "left" && focusedFieldIndex === 3) {
        cycleIconOption(-1);
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "right" && focusedFieldIndex === 3) {
        cycleIconOption(1);
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
            formFields.group = formFields.group.slice(0, -1);
            syncGroupOptionIndex();
          } else if (focusedFieldIndex === 3) {
            formFields.icon = formFields.icon.slice(0, -1);
            syncIconOptionIndex();
          }
          safeRender();
        }
        event.preventDefault();
        return;
      }

      if (event.sequence && !event.ctrl && !event.meta && !/[\x00-\x1F\x7F]/.test(event.sequence)) {
        if (isTextField(focusedFieldIndex)) {
          appendTextToFocusedField(event.sequence);
          safeRender();
        }
        event.preventDefault();
        return;
      }

      event.preventDefault();
      return;
    }

    if (isWidgetPickerActive) {
      if (event.name === "escape") {
        isWidgetPickerActive = false;
        widgetPickerIndex = 0;
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "up") {
        widgetPickerIndex = (widgetPickerIndex - 1 + WIDGET_REGISTRY.length) % WIDGET_REGISTRY.length;
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "down") {
        widgetPickerIndex = (widgetPickerIndex + 1) % WIDGET_REGISTRY.length;
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "return" || event.name === "enter") {
        const def = WIDGET_REGISTRY[widgetPickerIndex];
        if (def) {
          isWidgetPickerActive = false;
          resetWidgetForm(def.id);
          isWidgetFormActive = true;
          safeRender();
        }
        event.preventDefault();
        return;
      }

      event.preventDefault();
      return;
    }

    if (isWidgetFormActive) {
      widgetFormError = "";

      if (event.name === "escape") {
        isWidgetFormActive = false;
        widgetFormError = "";
        if (widgetFormMode === "edit" && widgetEditingIndex >= 0) {
          selectedIndex = widgetEditingIndex;
        }
        safeRender();
        event.preventDefault();
        return;
      }

      const def = getWidgetById(widgetFormType);
      const fields = def ? getWidgetFormFieldList(def) : [];
      const maxFieldIndex = fields.length;

      if (event.name === "up") {
        widgetFormFocusedIndex = (widgetFormFocusedIndex - 1 + maxFieldIndex + 1) % (maxFieldIndex + 1);
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "down") {
        widgetFormFocusedIndex = (widgetFormFocusedIndex + 1) % (maxFieldIndex + 1);
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "left") {
        const field = fields[widgetFormFocusedIndex];
        if (field?.kind === "service" && field.name === "group") {
          const groups = getDistinctGroupNames(services);
          const current = widgetFormFields.group.trim();
          const idx = groups.indexOf(current);
          const nextIdx = idx >= 0 ? (idx - 1 + groups.length) % groups.length : groups.length - 1;
          widgetFormFields.group = groups[nextIdx] ?? "";
          safeRender();
          event.preventDefault();
          return;
        }
        if (field?.kind === "service" && field.name === "icon") {
          const current = widgetFormFields.icon.trim();
          const idx = ICON_PRESETS.indexOf(current);
          const nextIdx = idx >= 0 ? (idx - 1 + ICON_PRESETS.length) % ICON_PRESETS.length : ICON_PRESETS.length - 1;
          widgetFormFields.icon = ICON_PRESETS[nextIdx] ?? "";
          safeRender();
          event.preventDefault();
          return;
        }
        if (field?.kind === "widget" && field.field.type === "select" && field.field.options) {
          const current = widgetFormFields[field.field.name] ?? "";
          const opts = field.field.options;
          const idx = opts.indexOf(current);
          const nextIdx = idx >= 0 ? (idx - 1 + opts.length) % opts.length : opts.length - 1;
          widgetFormFields[field.field.name] = opts[nextIdx] ?? "";
          safeRender();
          event.preventDefault();
          return;
        }
      }

      if (event.name === "right") {
        const field = fields[widgetFormFocusedIndex];
        if (field?.kind === "service" && field.name === "group") {
          const groups = getDistinctGroupNames(services);
          const current = widgetFormFields.group.trim();
          const idx = groups.indexOf(current);
          const nextIdx = idx >= 0 ? (idx + 1) % groups.length : 0;
          widgetFormFields.group = groups[nextIdx] ?? "";
          safeRender();
          event.preventDefault();
          return;
        }
        if (field?.kind === "service" && field.name === "icon") {
          const current = widgetFormFields.icon.trim();
          const idx = ICON_PRESETS.indexOf(current);
          const nextIdx = idx >= 0 ? (idx + 1) % ICON_PRESETS.length : 0;
          widgetFormFields.icon = ICON_PRESETS[nextIdx] ?? "";
          safeRender();
          event.preventDefault();
          return;
        }
        if (field?.kind === "widget" && field.field.type === "select" && field.field.options) {
          const current = widgetFormFields[field.field.name] ?? "";
          const opts = field.field.options;
          const idx = opts.indexOf(current);
          const nextIdx = idx >= 0 ? (idx + 1) % opts.length : 0;
          widgetFormFields[field.field.name] = opts[nextIdx] ?? "";
          safeRender();
          event.preventDefault();
          return;
        }
      }

      if (event.name === "return" || event.name === "enter") {
        if (widgetFormFocusedIndex === maxFieldIndex) {
          void submitWidgetForm();
          event.preventDefault();
          return;
        }
      }

      if (event.name === "backspace") {
        const field = fields[widgetFormFocusedIndex];
        if (field?.kind === "service") {
          widgetFormFields[field.name] = (widgetFormFields[field.name] ?? "").slice(0, -1);
          safeRender();
        } else if (field?.kind === "widget") {
          widgetFormFields[field.field.name] = (widgetFormFields[field.field.name] ?? "").slice(0, -1);
          safeRender();
        }
        event.preventDefault();
        return;
      }

      if (event.sequence && !event.ctrl && !event.meta && !/[\x00-\x1F\x7F]/.test(event.sequence)) {
        const field = fields[widgetFormFocusedIndex];
        if (field?.kind === "service") {
          widgetFormFields[field.name] = (widgetFormFields[field.name] ?? "") + event.sequence;
          safeRender();
        } else if (field?.kind === "widget") {
          widgetFormFields[field.field.name] = (widgetFormFields[field.field.name] ?? "") + event.sequence;
          safeRender();
        }
        event.preventDefault();
        return;
      }

      event.preventDefault();
      return;
    }

    if (isSearchMode) {
      if (event.name === "escape") {
        isSearchMode = false;
        searchQuery = "";
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "return" || event.name === "enter") {
        const query = searchQuery.trim();
        if (query) {
          void open(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
        }
        isSearchMode = false;
        searchQuery = "";
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "backspace") {
        searchQuery = searchQuery.slice(0, -1);
        ensureSelectionWithinActive(getActiveServiceIndexes());
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "left") {
        moveSelection(-1);
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "right") {
        moveSelection(1);
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "up") {
        moveSelection(-CARD_COLUMNS);
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.name === "down") {
        moveSelection(CARD_COLUMNS);
        safeRender();
        event.preventDefault();
        return;
      }

      if (event.sequence && !event.ctrl && !event.meta && !/[\x00-\x1F\x7F]/.test(event.sequence)) {
        searchQuery += event.sequence;
        ensureSelectionWithinActive(getActiveServiceIndexes());
        safeRender();
        event.preventDefault();
        return;
      }

      event.preventDefault();
      return;
    }

    if (event.name === "left") {
      moveSelection(-1);
      safeRender();
      event.preventDefault();
      return;
    }

    if (event.name === "right") {
      moveSelection(1);
      safeRender();
      event.preventDefault();
      return;
    }

    if (event.name === "up") {
      moveSelection(-CARD_COLUMNS);
      safeRender();
      event.preventDefault();
      return;
    }

    if (event.name === "down") {
      moveSelection(CARD_COLUMNS);
      safeRender();
      event.preventDefault();
      return;
    }

    if ((event.sequence === "n" || event.name === "n") && !event.ctrl && !event.meta) {
      isSettingsFormActive = false;
      resetForm();
      isFormActive = true;
      safeRender();
      event.preventDefault();
      return;
    }

    if ((event.sequence === "s" || event.name === "s") && !event.ctrl && !event.meta) {
      isFormActive = false;
      startSettingsForm();
      safeRender();
      event.preventDefault();
      return;
    }

    if ((event.sequence === "t" || event.name === "t") && !event.ctrl && !event.meta) {
      cycleServiceView();
      safeRender();
      event.preventDefault();
      return;
    }

    if ((event.sequence === "f" || event.name === "f") && !event.ctrl && !event.meta) {
      isSearchMode = true;
      searchQuery = "";
      currentView = { kind: "all" };
      ensureSelectionWithinActive(getActiveServiceIndexes());
      safeRender();
      event.preventDefault();
      return;
    }

    if ((event.sequence === "w" || event.name === "w") && !event.ctrl && !event.meta) {
      isFormActive = false;
      isSettingsFormActive = false;
      isSearchMode = false;
      isWidgetPickerActive = true;
      widgetPickerIndex = 0;
      safeRender();
      event.preventDefault();
      return;
    }

    if (event.name === "return" || event.name === "enter") {
      const active = getActiveServiceIndexes();
      if (active.length > 0) {
        ensureSelectionWithinActive(active);
        const selected = services[selectedIndex];
        if (selected.type === "widget") {
          void refreshWidgetData(selectedIndex);
        } else {
          const normalized = normalizeServiceUrl(selected.url);
          void open(normalized);
        }
      }
      event.preventDefault();
      return;
    }

    if ((event.sequence === "e" || event.name === "e") && !event.ctrl && !event.meta) {
      const active = getActiveServiceIndexes();
      if (active.length > 0) {
        ensureSelectionWithinActive(active);
        const selected = services[selectedIndex];
        if (selected.type === "widget") {
          startWidgetEditForm(selectedIndex);
          isWidgetFormActive = true;
          safeRender();
        } else {
          startEditForm(selectedIndex);
          safeRender();
        }
      }
      event.preventDefault();
      return;
    }

    if ((event.sequence === "d" || event.name === "d") && !event.ctrl && !event.meta) {
      const active = getActiveServiceIndexes();
      if (active.length > 0) {
        ensureSelectionWithinActive(active);
        void deleteService(selectedIndex);
      }
      event.preventDefault();
      return;
    }


    if ((event.sequence === "r" || event.name === "r") && !event.ctrl && !event.meta) {
      void refreshHealth(true).catch((error) => failFast(error, "manual refresh failure"));
      event.preventDefault();
      return;
    }

  });

  renderer.keyInput.on("paste", (event: PasteEvent) => {
    if (isSettingsFormActive && settingsFocusedFieldIndex === 1) {
      const pasted = textDecoder.decode(event.bytes).replace(/\D+/g, "");
      if (pasted) {
        settingsFormFields.autoRefreshIntervalSec += pasted;
        safeRender();
      }
      event.preventDefault();
      return;
    }

    if (isSettingsFormActive && settingsFocusedFieldIndex === 2) {
      const pasted = textDecoder.decode(event.bytes).replace(/\D+/g, "");
      if (pasted) {
        settingsFormFields.selectedAutoRefreshIntervalSec += pasted;
        safeRender();
      }
      event.preventDefault();
      return;
    }

    if (isSearchMode) {
      const pasted = textDecoder.decode(event.bytes).replace(/[\r\n]+/g, "");
      if (pasted) {
        searchQuery += pasted;
        ensureSelectionWithinActive(getActiveServiceIndexes());
        safeRender();
      }
      event.preventDefault();
      return;
    }

    if (isWidgetFormActive) {
      const def = getWidgetById(widgetFormType);
      const fields = def ? getWidgetFormFieldList(def) : [];
      const field = fields[widgetFormFocusedIndex];
      const pasted = textDecoder.decode(event.bytes).replace(/[\r\n]+/g, "");
      if (pasted) {
        if (field?.kind === "service") {
          widgetFormFields[field.name] = (widgetFormFields[field.name] ?? "") + pasted;
        } else if (field?.kind === "widget") {
          widgetFormFields[field.field.name] = (widgetFormFields[field.field.name] ?? "") + pasted;
        }
        safeRender();
      }
      event.preventDefault();
      return;
    }

    if (!isFormActive || !isTextField(focusedFieldIndex)) {
      event.preventDefault();
      return;
    }

    appendTextToFocusedField(textDecoder.decode(event.bytes));
    safeRender();
    event.preventDefault();
  });

  process.once("SIGINT", exitGracefully);
  process.once("exit", stop);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`homestat: ${message}`);
  process.exit(1);
});

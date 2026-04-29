import "@opentui/core/runtime-plugin-support";
import { BoxRenderable, createCliRenderer, type KeyEvent, TextRenderable } from "@opentui/core";
import open from "open";
import { loadConfig } from "./config.ts";
import {
  createInitialHealth,
  evaluateStatus,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_CHECK_TIMEOUT_MS,
  normalizeServiceUrl,
  relativeTime,
} from "./health.ts";
import type { FlatService, ServiceHealth } from "./types.ts";

const COLORS = {
  online: "#86efac",
  offline: "#fca5a5",
  unknown: "#a3a3a3",
  focused: "#c4b5fd",
  text: "#e5e7eb",
  muted: "#94a3b8",
} as const;

function truncate(value: string, length: number): string {
  if (value.length <= length) {
    return value;
  }

  return `${value.slice(0, Math.max(0, length - 1))}…`;
}

function flattenServices(config: Awaited<ReturnType<typeof loadConfig>>): FlatService[] {
  return config.groups.flatMap((group) =>
    group.services.map((service) => ({
      groupName: group.name,
      service,
    })),
  );
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

async function main() {
  const config = await loadConfig();
  const services = flattenServices(config);

  if (services.length === 0) {
    throw new Error("No services configured. Add at least one service in ~/.homestat/config.json.");
  }

  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    useMouse: false,
    exitOnCtrlC: false,
  });

  const root = new BoxRenderable(renderer, {
    id: "root",
    width: "100%",
    height: "100%",
    flexDirection: "row",
    padding: 1,
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

  const detailsPanel = new BoxRenderable(renderer, {
    id: "details-panel",
    width: "32%",
    height: "100%",
    border: true,
    title: "Details",
    padding: 1,
    gap: 0,
  });

  const CARD_COLUMNS = 2;
  const CARD_HEIGHT = 7;
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
      }),
  );

  const cardMainTexts = services.map(
    (_, index) =>
      new TextRenderable(renderer, {
        id: `service-main-${index}`,
        content: "",
        fg: COLORS.text,
      }),
  );

  const cardStatusTexts = services.map(
    (_, index) =>
      new TextRenderable(renderer, {
        id: `service-status-${index}`,
        content: "",
        fg: COLORS.unknown,
      }),
  );

  const addNewCard = new BoxRenderable(renderer, {
    id: `service-row-add-new`,
    width: "48%",
    height: CARD_HEIGHT,
    padding: 1,
    border: true,
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
  });

  const addNewText = new TextRenderable(renderer, {
    id: "add-new-text",
    content: "+ Add Service",
    fg: COLORS.text,
  });

  const addNewHint = new TextRenderable(renderer, {
    id: "add-new-hint",
    content: "(coming soon)",
    fg: COLORS.muted,
  });

  addNewCard.add(addNewText);
  addNewCard.add(addNewHint);

  const detailsTitle = new TextRenderable(renderer, {
    id: "details-title",
    content: "",
    fg: COLORS.focused,
  });

  const detailsGroup = new TextRenderable(renderer, {
    id: "details-group",
    content: "",
    fg: COLORS.muted,
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

  const detailsHint = new TextRenderable(renderer, {
    id: "details-hint",
    content: "←/→/↑/↓ navigate • Enter to open • Ctrl+C quit",
    fg: COLORS.muted,
  });

  renderer.root.add(root);
  root.add(servicesPanel);
  root.add(detailsPanel);

  servicesPanel.add(cardsViewport);
  cardsViewport.add(cardsGrid);

  for (const [index, rowText] of rowTexts.entries()) {
    cardsGrid.add(rowText);
    rowText.add(cardMainTexts[index]);
    rowText.add(cardStatusTexts[index]);
  }
  cardsGrid.add(addNewCard);

  detailsPanel.add(detailsTitle);
  detailsPanel.add(detailsGroup);
  detailsPanel.add(detailsUrl);
  detailsPanel.add(detailsHealth);
  detailsPanel.add(detailsChecked);
  detailsPanel.add(detailsError);
  detailsPanel.add(detailsHint);

  const health = services.map(() => createInitialHealth());
  let selectedIndex = 0;
  let scrollRowOffset = 0;

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
    for (const [index, row] of services.entries()) {
      const rowHealth = health[index];
      const icon = row.service.icon ?? "•";
      const name = truncate(row.service.name, 22);
      const url = truncate(row.service.url, 32);
      const badge = statusText(rowHealth.state);
      const code = truncate(rowHealth.errorCode ?? "none", 16);
      const focused = index === selectedIndex;

      cardMainTexts[index].content = `${icon} ${name}\n${url}`;
      cardMainTexts[index].fg = focused ? COLORS.focused : COLORS.text;
      cardStatusTexts[index].content = `${badge} • ${code}`;
      cardStatusTexts[index].fg = statusColor(rowHealth.state);
      rowTexts[index].borderStyle = focused ? "double" : "single";
    }

    const selectedRow = Math.floor(selectedIndex / CARD_COLUMNS);
    const visibleRows = Math.max(1, Math.floor(cardsViewport.height / CARD_ROW_STRIDE));

    if (selectedRow < scrollRowOffset) {
      scrollRowOffset = selectedRow;
    } else if (selectedRow >= scrollRowOffset + visibleRows) {
      scrollRowOffset = selectedRow - visibleRows + 1;
    }

    cardsGrid.translateY = -(scrollRowOffset * CARD_ROW_STRIDE);

    if (selectedIndex === services.length) {
      addNewText.fg = COLORS.focused;
      addNewHint.fg = COLORS.focused;
      addNewCard.borderStyle = "double";

      detailsTitle.content = "+ Add New Service";
      detailsGroup.content = "Create service editor coming soon";
      detailsUrl.content = "";
      detailsHealth.content = "";
      detailsChecked.content = "";
      detailsError.content = "";
    } else {
      addNewText.fg = COLORS.text;
      addNewHint.fg = COLORS.muted;
      addNewCard.borderStyle = "single";

      const selected = services[selectedIndex];
      const selectedHealth = health[selectedIndex];

      detailsTitle.content = `${selected.service.icon ?? "•"} ${selected.service.name}`;
      detailsGroup.content = `Group: ${selected.groupName}`;
      detailsUrl.content = `URL: ${selected.service.url}`;
      detailsHealth.content = `Health: ${statusText(selectedHealth.state)}`;
      detailsChecked.content = `Last checked: ${relativeTime(selectedHealth.lastCheckedAt)}`;
      detailsError.content = `Error: ${selectedHealth.errorDetails ?? "none"}`;
      detailsHealth.fg = statusColor(selectedHealth.state);
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

  const refreshHealth = async () => {
    if (stopped) {
      return;
    }

    await Promise.all(
      services.map(async (row, index) => {
        const result = await checkService(row.service.url);
        health[index] = {
          state: result.state,
          errorCode: result.errorCode,
          errorDetails: result.errorDetails,
          lastCheckedAt: Date.now(),
        };
      }),
    );

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

  renderer.keyInput.on("keypress", (event: KeyEvent) => {
    if (event.ctrl && event.name === "c") {
      event.preventDefault();
      exitGracefully();
      return;
    }

    if (event.name === "left") {
      selectedIndex = (selectedIndex - 1 + services.length + 1) % (services.length + 1);
      safeRender();
      event.preventDefault();
      return;
    }

    if (event.name === "right") {
      selectedIndex = (selectedIndex + 1) % (services.length + 1);
      safeRender();
      event.preventDefault();
      return;
    }

    if (event.name === "up") {
      selectedIndex = (selectedIndex - CARD_COLUMNS + services.length + 1) % (services.length + 1);
      safeRender();
      event.preventDefault();
      return;
    }

    if (event.name === "down") {
      selectedIndex = (selectedIndex + CARD_COLUMNS) % (services.length + 1);
      safeRender();
      event.preventDefault();
      return;
    }

    if (event.name === "return" || event.name === "enter") {
      if (selectedIndex === services.length) {
        // "Add New Service" clicked, do nothing for now as requested
        event.preventDefault();
        return;
      }
      
      const selected = services[selectedIndex];
      const normalized = normalizeServiceUrl(selected.service.url);
      void open(normalized);
      event.preventDefault();
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

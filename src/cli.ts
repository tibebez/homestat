import "@opentui/core/runtime-plugin-support";
import { BoxRenderable, createCliRenderer, type KeyEvent, TextRenderable } from "@opentui/core";
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
import type { FlatService, Service, ServiceHealth } from "./types.ts";

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

  const formGroupName = new TextRenderable(renderer, {
    id: "form-group-name",
    content: "",
    fg: COLORS.text,
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
  detailsPanel.add(formGroupName);
  detailsPanel.add(detailsUrl);
  detailsPanel.add(detailsHealth);
  detailsPanel.add(detailsChecked);
  detailsPanel.add(detailsError);
  detailsPanel.add(detailsHint);

  const health = services.map(() => createInitialHealth());
  let selectedIndex = 0;
  let scrollRowOffset = 0;

  let isFormActive = false;
  const formFields = {
    groupIndex: config.groups.length > 0 ? 0 : ("new" as const),
    groupName: "",
    serviceName: "",
    url: "",
    icon: "•",
  };
  let focusedFieldIndex = 0;
  let formError = "";
  let isSubmitting = false;

  function resetForm() {
    formFields.groupIndex = config.groups.length > 0 ? 0 : "new";
    formFields.groupName = "";
    formFields.serviceName = "";
    formFields.url = "";
    formFields.icon = "•";
    focusedFieldIndex = 0;
    formError = "";
  }

  async function submitForm() {
    if (isSubmitting) return;
    isSubmitting = true;

    try {
      if (formFields.groupIndex === "new" && !formFields.groupName.trim()) {
        formError = "Error: Group name is required.";
        safeRender();
        return;
      }
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

      const newService: Service = {
        name: formFields.serviceName.trim(),
        url: formFields.url.trim(),
        icon: formFields.icon.trim() || "•",
      };

      let groupName: string;
      if (formFields.groupIndex === "new") {
        groupName = formFields.groupName.trim();
        config.groups.push({ name: groupName, services: [newService] });
      } else {
        const group = config.groups[formFields.groupIndex as number];
        group.services.push(newService);
        groupName = group.name;
      }

      await saveConfig(config);

      const flatService: FlatService = { groupName, service: newService };
      services.push(flatService);

      const newIndex = services.length - 1;
      const newRowText = new BoxRenderable(renderer, {
        id: `service-row-${newIndex}`,
        width: "48%",
        height: CARD_HEIGHT,
        padding: 1,
        border: true,
        flexDirection: "column",
        justifyContent: "space-between",
      });
      const newCardMain = new TextRenderable(renderer, {
        id: `service-main-${newIndex}`,
        content: "",
        fg: COLORS.text,
      });
      const newCardStatus = new TextRenderable(renderer, {
        id: `service-status-${newIndex}`,
        content: "",
        fg: COLORS.unknown,
      });

      newRowText.add(newCardMain);
      newRowText.add(newCardStatus);
      cardsGrid.insertBefore(newRowText, addNewCard);

      rowTexts.push(newRowText);
      cardMainTexts.push(newCardMain);
      cardStatusTexts.push(newCardStatus);
      health.push(createInitialHealth());

      isFormActive = false;
      selectedIndex = newIndex;
      formError = "";

      safeRender();

      void checkService(newService.url).then((result) => {
        health[newIndex] = {
          state: result.state,
          errorCode: result.errorCode,
          errorDetails: result.errorDetails,
          lastCheckedAt: Date.now(),
        };
        safeRender();
      });
    } finally {
      isSubmitting = false;
    }
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
    } else {
      addNewText.fg = COLORS.text;
      addNewHint.fg = COLORS.muted;
      addNewCard.borderStyle = "single";
    }

    if (isFormActive) {
      const FIELDS = {
        group: 0,
        groupName: 1,
        serviceName: 2,
        url: 3,
        icon: 4,
        save: 5,
      };

      const pw = detailsPanel.width;

      detailsTitle.content = "+ Add New Service";
      detailsTitle.fg = COLORS.focused;

      const groupFocused = focusedFieldIndex === FIELDS.group;
      const groupValue = formFields.groupIndex === "new" ? "+ New Group" : config.groups[formFields.groupIndex].name;
      detailsGroup.content = formFieldLine("Group", groupValue, groupFocused, pw);
      detailsGroup.fg = groupFocused ? COLORS.focused : COLORS.text;

      if (formFields.groupIndex === "new") {
        const groupNameFocused = focusedFieldIndex === FIELDS.groupName;
        formGroupName.content = formFieldLine("Group Name", formFields.groupName, groupNameFocused, pw);
        formGroupName.fg = groupNameFocused ? COLORS.focused : COLORS.text;
      } else {
        formGroupName.content = "";
      }

      const serviceNameFocused = focusedFieldIndex === FIELDS.serviceName;
      detailsUrl.content = formFieldLine("Name", formFields.serviceName, serviceNameFocused, pw);
      detailsUrl.fg = serviceNameFocused ? COLORS.focused : COLORS.text;

      const urlFocused = focusedFieldIndex === FIELDS.url;
      detailsHealth.content = formFieldLine("URL", formFields.url, urlFocused, pw);
      detailsHealth.fg = urlFocused ? COLORS.focused : COLORS.text;

      const iconFocused = focusedFieldIndex === FIELDS.icon;
      detailsChecked.content = formFieldLine("Icon", formFields.icon, iconFocused, pw);
      detailsChecked.fg = iconFocused ? COLORS.focused : COLORS.text;

      if (formError) {
        const errorPrefix = "Error: ";
        const contentWidth = Math.max(10, pw - 4);
        detailsError.content = errorPrefix + truncate(formError.slice(errorPrefix.length), Math.max(3, contentWidth - errorPrefix.length));
        detailsError.fg = COLORS.offline;
      } else {
        const saveFocused = focusedFieldIndex === FIELDS.save;
        detailsError.content = `${saveFocused ? "> " : "  "}[Save]`;
        detailsError.fg = saveFocused ? COLORS.focused : COLORS.muted;
      }

      detailsHint.content = "↑/↓ navigate fields • Type to edit • Enter to save • Esc to cancel";
    } else if (selectedIndex === services.length) {
      detailsTitle.content = "+ Add New Service";
      detailsTitle.fg = COLORS.focused;
      detailsGroup.content = "Create service editor coming soon";
      detailsGroup.fg = COLORS.muted;
      detailsUrl.content = "";
      detailsUrl.fg = COLORS.text;
      detailsHealth.content = "";
      detailsHealth.fg = COLORS.text;
      detailsChecked.content = "";
      detailsChecked.fg = COLORS.text;
      detailsError.content = "";
      detailsError.fg = COLORS.text;
      detailsHint.content = "←/→/↑/↓ navigate • Enter to open • Ctrl+C quit";
      formGroupName.content = "";
    } else {
      const selected = services[selectedIndex];
      const selectedHealth = health[selectedIndex];
      const pw = detailsPanel.width;
      const contentWidth = Math.max(10, pw - 4);

      const titlePrefix = `${selected.service.icon ?? "•"} `;
      detailsTitle.content = titlePrefix + truncate(selected.service.name, Math.max(3, contentWidth - titlePrefix.length));
      detailsTitle.fg = COLORS.focused;

      const groupPrefix = "Group: ";
      detailsGroup.content = groupPrefix + truncate(selected.groupName, Math.max(3, contentWidth - groupPrefix.length));
      detailsGroup.fg = COLORS.muted;

      const urlPrefix = "URL: ";
      detailsUrl.content = urlPrefix + truncate(selected.service.url, Math.max(3, contentWidth - urlPrefix.length));
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

      detailsHint.content = "←/→/↑/↓ navigate • Enter to open • Ctrl+C quit";
      formGroupName.content = "";
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

  const isTextField = (index: number): boolean =>
    index === 1 || index === 2 || index === 3 || index === 4;

  const nextField = (): void => {
    const max = 5;
    do {
      focusedFieldIndex = (focusedFieldIndex + 1) % (max + 1);
    } while (formFields.groupIndex !== "new" && focusedFieldIndex === 1);
  };

  const prevField = (): void => {
    const max = 5;
    do {
      focusedFieldIndex = (focusedFieldIndex - 1 + max + 1) % (max + 1);
    } while (formFields.groupIndex !== "new" && focusedFieldIndex === 1);
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
        selectedIndex = services.length;
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

      if (event.name === "return" || event.name === "enter") {
        if (focusedFieldIndex === 0) {
          if (formFields.groupIndex === "new") {
            formFields.groupIndex = 0;
          } else if (formFields.groupIndex === config.groups.length - 1) {
            formFields.groupIndex = "new";
          } else {
            formFields.groupIndex = (formFields.groupIndex as number) + 1;
          }
          safeRender();
          event.preventDefault();
          return;
        }

        if (focusedFieldIndex === 5) {
          void submitForm();
          event.preventDefault();
          return;
        }
      }

      if (event.name === "backspace") {
        if (isTextField(focusedFieldIndex)) {
          if (focusedFieldIndex === 1) {
            formFields.groupName = formFields.groupName.slice(0, -1);
          } else if (focusedFieldIndex === 2) {
            formFields.serviceName = formFields.serviceName.slice(0, -1);
          } else if (focusedFieldIndex === 3) {
            formFields.url = formFields.url.slice(0, -1);
          } else if (focusedFieldIndex === 4) {
            formFields.icon = formFields.icon.slice(0, -1);
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
          if (focusedFieldIndex === 1) {
            formFields.groupName += event.sequence;
          } else if (focusedFieldIndex === 2) {
            formFields.serviceName += event.sequence;
          } else if (focusedFieldIndex === 3) {
            formFields.url += event.sequence;
          } else if (focusedFieldIndex === 4) {
            formFields.icon += event.sequence;
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
        isFormActive = true;
        resetForm();
        safeRender();
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

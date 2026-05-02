import type { WidgetDefinition } from "./types.ts";
import { tautulliWidget } from "./tautulli.ts";
import { jellyfinWidget } from "./jellyfin.ts";
import { sonarrWidget } from "./sonarr.ts";
import { radarrWidget } from "./radarr.ts";

export * from "./types.ts";
export { tautulliWidget } from "./tautulli.ts";
export { jellyfinWidget } from "./jellyfin.ts";
export { sonarrWidget } from "./sonarr.ts";
export { radarrWidget } from "./radarr.ts";

export const WIDGET_REGISTRY: WidgetDefinition[] = [
  tautulliWidget,
  jellyfinWidget,
  sonarrWidget,
  radarrWidget,
];

export function getWidgetById(id: string): WidgetDefinition | undefined {
  return WIDGET_REGISTRY.find((w) => w.id === id);
}

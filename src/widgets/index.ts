import type { WidgetDefinition } from "./types.ts";
import { tautulliWidget } from "./tautulli.ts";
import { jellyfinWidget } from "./jellyfin.ts";

export * from "./types.ts";
export { tautulliWidget } from "./tautulli.ts";
export { jellyfinWidget } from "./jellyfin.ts";

export const WIDGET_REGISTRY: WidgetDefinition[] = [tautulliWidget, jellyfinWidget];

export function getWidgetById(id: string): WidgetDefinition | undefined {
  return WIDGET_REGISTRY.find((w) => w.id === id);
}

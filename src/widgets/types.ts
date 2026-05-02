export interface WidgetField {
  name: string;
  label: string;
  type: "text" | "password" | "number" | "select";
  required?: boolean;
  placeholder?: string;
  options?: string[];
}

export interface WidgetDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;
  fields: WidgetField[];
  fetchData(config: Record<string, string>): Promise<unknown>;
  render(data: unknown, width: number): string[];
}

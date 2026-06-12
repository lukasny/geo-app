// Shared severity display helpers. Replaces duplicated severityTone
// implementations and the "CRITICAL" vs "Critical" casing drift between
// the audit page and the action plan. Safe to import from anywhere.

import type { ComponentProps } from "react";
import type { Badge } from "@shopify/polaris";

type BadgeTone = ComponentProps<typeof Badge>["tone"];

export function severityTone(severity: string): BadgeTone {
  switch (severity) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "warning";
    case "MEDIUM":
      return "attention";
    default:
      return "info";
  }
}

/** Title-case label: "CRITICAL" -> "Critical". */
export function severityLabel(severity: string): string {
  if (!severity) return severity;
  return severity.charAt(0).toUpperCase() + severity.slice(1).toLowerCase();
}

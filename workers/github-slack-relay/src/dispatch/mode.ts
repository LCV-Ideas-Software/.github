// ADR-001 §6.8 — DISPATCH_MODE parsing (fail-safe to off, R20) and the
// mode-invariant presence fence from the outbox perspective (R11).
import type { DispatchMode, DispatchState } from "./contract";

export type FenceDecision =
  | "blocked_other_path"
  | "duplicate_same_path"
  | "accept_new";

export function parseDispatchMode(value: unknown): DispatchMode {
  if (value === "off" || value === "shadow" || value === "primary") {
    return value;
  }
  // §6.8 regime B fail-safe: ingress keeps persisting, egress pauses.
  return "off";
}

// §6.8/R11: the fence sees PRESENCE only and evaluates identically in every
// DISPATCH_MODE. A legacy row in ANY state means "possibly already posted";
// shadow outbox rows are excluded from the check (§9.A1).
export function fenceDecision(
  _mode: DispatchMode,
  hasLegacyRow: boolean,
  outboxRow: { state: DispatchState; shadow: boolean } | null,
): FenceDecision {
  if (hasLegacyRow) return "blocked_other_path";
  if (outboxRow !== null && !outboxRow.shadow) return "duplicate_same_path";
  return "accept_new";
}

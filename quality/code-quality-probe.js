/**
 * Analysis-only JavaScript marker for GitHub Code Quality.
 *
 * This module is deliberately not imported by the organization site or by any
 * governance runtime. Its only purpose is to keep one supported language in
 * this governance-only repository so the native Code Quality analysis has a
 * deterministic target.
 */
export const CODE_QUALITY_PROBE = Object.freeze({
  repository: "LCV-Ideas-Software/.github",
  purpose: "GitHub Code Quality language detection",
});

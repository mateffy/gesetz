// CLI entry point — re-exported by the `gesetz` wrapper package
export { runGesetz } from './main';

// Re-export public types useful for programmatic usage of the CLI layer
export { loadConfig, ConfigNotFoundError } from './load-config';
export {
  formatCategoryTable,
  formatViolations,


  formatCi,
  formatStatusBanner,
  formatList,
  detectFormat,
  AGENT_ENV_VARS,
  type OutputFormat,
} from './format';
export { MAX_VIOLATIONS, buildEnvelope, formatEnvelope } from './envelope';
export type { EnvelopeCoordination } from './envelope';
export { SKILL_MARKDOWN } from './skill';
export { initCommand } from './init';
export type {
  PresetId,
  ProjectProfile,
  DetectedTool,
  ToolId,
  Framework,
  PackageManager,
} from './init/detect';
export { detectProject } from './init/detect';
export {
  generateConfig,
  BLUEPRINTS,
  blueprintsForPreset,
  type RuleBlueprint,
  type Plan,
} from './init/rules';
export { PRESETS, PRESET_CHOICES } from './init/presets';
export { resolvePlanFromFlags, writeConfig, type InitFlags, type WriteResult } from './init/write';

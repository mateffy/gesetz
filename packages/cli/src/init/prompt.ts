/**
 * Interactive wizard for `regel init`.
 *
 * Uses `@effect/cli`'s `Prompt.*` API (already a dependency). Five prompts:
 *   Q1 select preset, Q2 multiSelect tools, Q3 multiSelect rules,
 *   Q4 confirm install, Q5 confirm qa-script.
 *
 * Each prompt's choices derive from the detected profile. Detected tools are
 * marked in their description. The suggested preset is the default choice.
 * On `QuitException` (Ctrl-C) the Effect fails cleanly → exit 1.
 */
import { Prompt } from '@effect/cli';
import type { QuitException, Terminal } from '@effect/platform/Terminal';
import { Console, Effect } from 'effect';
import type { ProjectProfile, ToolId, PresetId } from './detect';
import type { Plan } from './rules';
import { toolsForPreset, blueprintsForPreset } from './rules';
import { PRESET_CHOICES } from './presets';
import type { InitFlags } from './write';

const ALL_TOOLS: ToolId[] = [
  'oxlint',
  'oxfmt',
  'prettier',
  'eslint',
  'vitest',
  'bun-test',
  'storybook',
  'phpstan',
  'pest',
  'phpunit',
];

type PromptErr = QuitException | Error;

function runOverwriteGate(): Effect.Effect<boolean, PromptErr, Terminal> {
  return Prompt.confirm({
    message: 'regel.config.ts exists \u2014 overwrite it?',
    initial: false,
  });
}

function runPresetPrompt(profile: ProjectProfile): Effect.Effect<PresetId, PromptErr, Terminal> {
  const choices = PRESET_CHOICES.map((c) => ({
    title: c.title,
    value: c.value,
    description: c.description,
  }));
  return Prompt.select({
    message: `Choose a preset (detected framework: ${profile.framework})`,
    choices,
  });
}

function runToolsPrompt(
  profile: ProjectProfile,
  preset: PresetId,
): Effect.Effect<ToolId[], PromptErr, Terminal> {
  const detected = new Set(profile.detectedTools.map((t) => t.tool));
  const suggested = new Set(toolsForPreset(preset));
  const isLaravel = preset === 'laravel';
  const choices = ALL_TOOLS.filter((t) => {
    const isPhp = t === 'phpstan' || t === 'pest' || t === 'phpunit';
    return isLaravel ? isPhp : !isPhp;
  }).map((t) => ({
    title: String(t),
    value: t,
    description: detected.has(t)
      ? '\u2713 detected'
      : suggested.has(t)
        ? 'recommended'
        : 'not detected',
  }));
  const detectedList = [...detected].filter((t) =>
    isLaravel
      ? t === 'phpstan' || t === 'pest' || t === 'phpunit'
      : !(t === 'phpstan' || t === 'pest' || t === 'phpunit'),
  );
  return Prompt.multiSelect({
    message: `Select QA tools to wire in (detected: ${detectedList.join(', ') || 'none'} \u2014 press space to toggle)`,
    choices,
  }).pipe(
    Effect.map((arr) =>
      arr.filter((s): s is ToolId => ALL_TOOLS.includes(s as ToolId)),
    ),
  );
}

function runRulesPrompt(
  profile: ProjectProfile,
  preset: PresetId,
  tools: Set<ToolId>,
): Effect.Effect<string[], PromptErr, Terminal> {
  const ctx = { profile, tools };
  const presetRules = blueprintsForPreset(preset).filter((b) => !b.appliesTo || b.appliesTo(ctx));
  const choices = presetRules.map((b) => ({
    title: `[${b.category}] ${b.id} \u2014 ${b.label}`,
    value: b.id,
    description: b.description,
  }));
  return Prompt.multiSelect({
    message: `Select rules to include (${presetRules.length} from preset \u2014 space to toggle)`,
    choices,
  }).pipe(Effect.map((arr) => arr.map((s) => String(s))));
}

function runInstallPrompt(pm: string): Effect.Effect<boolean, PromptErr, Terminal> {
  return Prompt.confirm({
    message: `Install @regeln/* packages now via ${pm}? (recommended)`,
    initial: true,
  });
}

function runQaScriptPrompt(): Effect.Effect<boolean, PromptErr, Terminal> {
  return Prompt.confirm({
    message: 'Add a "qa": "regel check" script to package.json? (recommended)',
    initial: true,
  });
}

/**
 * Run the full wizard. Returns a Plan. Requires `Terminal` in the environment
 * (provided by `NodeContext.layer` at runtime).
 *
 * If `profile.hasExistingConfig && !flags.force`, an overwrite confirm is
 * prepended; declining exits without writing.
 */
export function runWizard(
  profile: ProjectProfile,
  flags: InitFlags,
): Effect.Effect<Plan, Error, Terminal> {
  return Effect.gen(function* () {
    if (profile.hasExistingConfig && !flags.force) {
      const overwrite = yield* runOverwriteGate();
      if (!overwrite) {
        yield* Console.log('Cancelled \u2014 no changes made.');
        return yield* Effect.fail(new Error('cancelled'));
      }
    }

    const preset = yield* runPresetPrompt(profile);
    const toolsArr = yield* runToolsPrompt(profile, preset);
    const tools = new Set(toolsArr);
    const rulesArr = yield* runRulesPrompt(profile, preset, tools);
    const install = flags.install
      ? yield* runInstallPrompt(profile.packageManager)
      : false;
    const qaScript = flags.qaScript
      ? yield* runQaScriptPrompt()
      : false;

    return {
      preset,
      tools,
      rules: new Set(rulesArr),
      install,
      qaScript,
      profile,
    };
  });
}

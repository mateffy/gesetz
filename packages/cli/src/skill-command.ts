/**
 * `gesetz skill`: the document an agent reads, plus the recipe for this project.
 *
 * The rendering is separated from the command so it can be tested without a process
 * or a working directory — the command itself only decides where the config comes
 * from and where the text goes.
 */
import { Command } from '@effect/cli';
import { Console, Effect } from 'effect';
import { loadConfig } from './load-config';
import { renderReplacements } from './replacements';
import { SKILL_MARKDOWN } from './skill';
import type { Rule } from '@gesetz/core';

/**
 * The whole document: the static part, then what this project's adapters replace.
 *
 * The second half is generated, never hand-maintained, so a project that installs an
 * adapter gets its recipe and one that installs none is told that plainly rather than
 * shown an empty list.
 */
export function renderSkillDocument(rules: readonly Rule[] | null): string {
  const recipe =
    rules === null
      ? 'No gesetz config found here, so there is no list of configured tools below.'
      : renderReplacements(rules);
  return `${SKILL_MARKDOWN.trimEnd()}\n\n${recipe}\n`;
}

export const skillCommand = Command.make(
  'skill',
  {},
  () =>
    Effect.gen(function* () {
      const config = yield* loadConfig(process.cwd(), {
        changedSince: undefined,
        configPath: undefined,
        projectRootOverride: false,
      }).pipe(Effect.catchAll(() => Effect.succeed(null)));
      yield* Console.log(renderSkillDocument(config === null ? null : config.rules).trimEnd());
    }),
).pipe(
  Command.withDescription(
    'Print agent skill markdown to stdout, including what the configured adapters replace',
  ),
);

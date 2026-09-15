import { describe, expect, it } from 'vitest';
import { BLUEPRINT_IMPORTS } from '../src/init/rules';

/**
 * `gesetz init` writes a config that imports the checks it enables. Those
 * imports were silently stale after checks moved between packages, so the
 * generated config did not compile: `noConsoleLog`, `noEmptyCatch`,
 * `noTrivialComment`, and `relativeImports` were imported from `@gesetz/core`,
 * which no longer exports them, and `noCrossModuleImports` did not exist at all.
 *
 * This guard fails if any blueprint names an export their package does not have.
 */
describe('init blueprint imports', () => {
  it('names only exports that actually exist', async () => {
    const modules = new Map<string, Record<string, unknown>>();
    const missing: string[] = [];

    for (const specs of Object.values(BLUEPRINT_IMPORTS)) {
      for (const { from, name } of specs) {
        let module = modules.get(from);
        if (module === undefined) {
          module = (await import(from)) as Record<string, unknown>;
          modules.set(from, module);
        }
        if (module[name] === undefined) missing.push(`${name} from ${from}`);
      }
    }

    expect(missing).toEqual([]);
  });
});

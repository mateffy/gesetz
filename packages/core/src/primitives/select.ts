import { Effect } from 'effect';
import micromatch from 'micromatch';
import { FileSystem, ProjectRoot, FileFilter } from '../services/fs';
import type { Check, File, Rule, RuleCategory, RuleGuidance, Violation } from '../engine/rule';
import type { SyntaxTree } from '../services/syntax-tree';
import type { ImportResolver } from '../services/import-resolver';

/**
 * Converts a human-readable label into a stable kebab-case slug.
 *
 * @example
 * slugify('All components need Storybook stories')
 * // => 'all-components-need-storybook-stories'
 */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-');
}

export interface Selector {
  /**
   * Exclude files matching these additional glob patterns.
   */
  exclude(...patterns: string[]): Selector;

  /**
   * Include additional glob patterns to scan.
   */
  include(...patterns: string[]): Selector;

  /**
   * Additional predicate to filter files after glob matching.
   */
  filter(predicate: (file: File) => boolean): Selector;

  /**
   * Sets a human-readable label for this rule.
   * The label is stored verbatim as `rule.description`.
   * The rule ID is derived by slugifying the label.
   *
   * @example
   * .label('All components need Storybook stories')
   * // rule.id = 'all-components-need-storybook-stories'
   * // rule.description = 'All components need Storybook stories'
   */
  label(humanLabel: string): Selector;

  /**
   * Sets the category for scoring aggregation.
   * Violations from this rule will roll up into a named category score.
   */
  category(cat: RuleCategory): Selector;

  /**
   * Sets agent-facing guidance for this rule (used by `gesetz list` and `gesetz skill`).
   */
  guidance(g: RuleGuidance): Selector;

  /**
   * Applies one or more Check functions to each matched file.
   * Terminates the selector and returns a Rule.
   */
  check(...checks: Check[]): Rule;

  /**
   * Sugar for a single per-file function, equivalent to `.check(fn)`.
   */
  forEach(fn: Check): Rule;
}

interface SelectorState {
  readonly patterns: string[];
  readonly exclusions: string[];
  readonly predicates: ReadonlyArray<(file: File) => boolean>;
  readonly humanLabel: string | null;
  readonly category: RuleCategory | undefined;
  readonly guidance: RuleGuidance | undefined;
}

function buildRule(state: SelectorState, checks: Check[]): Rule {
  const humanLabel = state.humanLabel;
  // Deterministic ID: prefer the human label (slugified); otherwise derive
  // from the glob patterns. No module-level counter — IDs must be stable
  // across runs and independent of test execution order.
  const id = humanLabel !== null
    ? slugify(humanLabel)
    : slugify(state.patterns.join(' ')) || 'rule';
  const description = humanLabel !== null ? humanLabel : `select(${state.patterns.join(', ')})`;

  const run: Effect.Effect<
    Violation[],
    never,
    FileSystem | SyntaxTree | ImportResolver | ProjectRoot | FileFilter
  > = Effect.gen(function* () {
      const fs = yield* FileSystem;
      const root = yield* ProjectRoot;

      const files = yield* fs.glob(state.patterns, { cwd: root }).pipe(
        Effect.catchAll(() => Effect.succeed<File[]>([])),
      );

      // Apply the optional --files filter (from CLI). When present, only files
      // matching the filter are scanned. When absent (FileFilterLive(null)),
      // matches() returns true for everything.
      const fileFilter = yield* FileFilter;

      // Apply exclusions, predicates, and the file filter
      const matching = files
        .filter((f) =>
          state.exclusions.length === 0
            ? true
            : !micromatch.isMatch(f.path, state.exclusions),
        )
        .filter((f) => state.predicates.every((pred) => pred(f)))
        .filter((f) => fileFilter.matches(f.path));

      // Run all checks on all files with bounded concurrency
      const results = yield* Effect.all(
        matching.flatMap((file) =>
          checks.map((check) =>
            check(file).pipe(
              Effect.map((violations) => violations.map((v) => ({ ...v, rule: id }))),
              Effect.catchAll(() => Effect.succeed<Violation[]>([])),
            ),
          ),
        ),
        { concurrency: 10 },
      );

      return results.flat();
    });

  return { id, description, category: state.category, guidance: state.guidance, run };
}

function createSelector(state: SelectorState): Selector {
  return {
    exclude: (...patterns) =>
      createSelector({ ...state, exclusions: [...state.exclusions, ...patterns] }),

    include: (...patterns) =>
      createSelector({ ...state, patterns: [...state.patterns, ...patterns] }),

    filter: (predicate) =>
      createSelector({ ...state, predicates: [...state.predicates, predicate] }),

    label: (humanLabel) => createSelector({ ...state, humanLabel }),

    category: (cat) => createSelector({ ...state, category: cat }),

    guidance: (g) => createSelector({ ...state, guidance: g }),

    check: (...checks) => buildRule(state, checks),

    forEach: (fn) => buildRule(state, [fn]),
  };
}

/**
 * Creates a rule selector targeting files matching the given glob pattern(s).
 *
 * @example
 * ```ts
 * const rule = select('src/**\/*.tsx')
 *   .exclude('**\/*.test.tsx', '**\/*.stories.tsx')
 *   .label('All components need Storybook stories')
 *   .check(requireSibling('.stories.tsx'));
 *
 * rule.id;          // 'all-components-need-storybook-stories'
 * rule.description; // 'All components need Storybook stories'
 * ```
 */
export function select(...patterns: string[]): Selector {
  return createSelector({
    patterns,
    exclusions: [],
    predicates: [],
    humanLabel: null,
    category: undefined,
    guidance: undefined,
  });
}

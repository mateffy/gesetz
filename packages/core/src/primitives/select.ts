import { Effect, Runtime } from 'effect';
import micromatch from 'micromatch';
import { FileSystem, ProjectRoot, FileFilter } from '../services/fs';
import type { Check, CheckServices, File, Rule, RuleCategory, RuleGuidance, Violation } from '../engine/rule';
import { SyntaxTree } from '../services/syntax-tree';
import { ImportResolver } from '../services/import-resolver';

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

/**
 * Inline options for {@link select}. Every field is optional and equivalent to
 * the corresponding builder call, so `select(glob, { exclude, category })` is
 * shorthand for `select(glob).exclude(...).category(...)`.
 */
export interface SelectOptions {
  /** Extra glob patterns to exclude (equivalent to `.exclude(...)`). */
  readonly exclude?: string | readonly string[] | undefined;
  /** Extra glob patterns to include (equivalent to `.include(...)`). */
  readonly include?: string | readonly string[] | undefined;
  /** Scoring category (equivalent to `.category(...)`). */
  readonly category?: RuleCategory | undefined;
  /** Human-readable label (equivalent to `.label(...)`). */
  readonly label?: string | undefined;
  /** Agent-facing guidance (equivalent to `.guidance(...)`). */
  readonly guidance?: RuleGuidance | undefined;
}

function asArray(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : [...value];
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
      const st = yield* SyntaxTree;
      const ir = yield* ImportResolver;

      // Capture the current runtime so service calls inside async checks
      // still resolve against the injected layers.
      const runtime = yield* Effect.runtime<
        FileSystem | SyntaxTree | ImportResolver | ProjectRoot | FileFilter
      >();

      const services: CheckServices = {
        fs: {
          glob: async (pattern, options) =>
            Runtime.runPromise(runtime)(fs.glob(pattern, options)),
          readFile: async (path) => Runtime.runPromise(runtime)(fs.readFile(path)),
          exists: async (path) => Runtime.runPromise(runtime)(fs.exists(path)),
        },
        syntax: {
          canProcess: (file) => st.canProcess(file),
          process: async (file, options) =>
            Runtime.runPromise(runtime)(st.process(file, options)),
        },
        imports: {
          resolve: (fromFile, specifier) => ir.resolve(fromFile, specifier),
        },
        projectRoot: root,
      };

      const fileFilter = yield* FileFilter;

      // When --files is active, narrow the glob to only scan those files
      // instead of the full codebase. The rule's own patterns are applied
      // as a post-glob micromatch filter.
      const globPatterns = fileFilter.patterns !== null && fileFilter.patterns.length > 0
        ? [...fileFilter.patterns]
        : state.patterns;

      const files = yield* fs.glob(globPatterns, { cwd: root }).pipe(
        Effect.catchAll(() => Effect.succeed<File[]>([])),
      );

      // Apply exclusions, predicates, and --files-narrowed rule patterns
      const matching = files
        .filter((f) =>
          state.exclusions.length === 0
            ? true
            : !micromatch.isMatch(f.path, state.exclusions),
        )
        .filter((f) => state.predicates.every((pred) => pred(f)))
        .filter((f) => {
          // When we used --files patterns for globbing, also filter by the
          // rule's own select() patterns to exclude non-matching files.
          if (globPatterns !== state.patterns) {
            return micromatch.isMatch(f.path, state.patterns);
          }
          return true;
        });

      // Run all checks on all files with bounded concurrency.
      //
      // A check that throws must not look like a check that found nothing. This used
      // to swallow the failure and return no violations, which made a rule that threw
      // on 137 files indistinguishable from a rule that examined 137 clean files — a
      // green gate over an unexamined file. The failure becomes a violation instead, so
      // it flows through reporting, the baseline and scoring like any other finding.
      const results = yield* Effect.all(
        matching.flatMap((file) =>
          checks.map((check) =>
            Effect.tryPromise({
              try: () => check(file, services),
              catch: (cause) => cause,
            }).pipe(
              Effect.map((violations) =>
                violations.map((v) => ({ ...v, rule: v.rule || id })),
              ),
              Effect.catchAll((cause) =>
                Effect.succeed<Violation[]>([
                  {
                    severity: 'error',
                    source: 'core',
                    rule: id,
                    path: file.path,
                    message: `Check could not run for this file: ${
                      cause instanceof Error ? cause.message : String(cause)
                    }`,
                  },
                ]),
              ),
            ),
          ),
        ),
        { concurrency: 10 },
      );

      return results.flat();
    });

  return {
    id,
    description,
    category: state.category,
    guidance: state.guidance,
    run,
    perFile: {
      patterns: state.patterns,
      exclusions: state.exclusions,
      predicates: state.predicates,
      checks,
    },
  };
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
 * An optional {@link SelectOptions} object may be passed as the final argument
 * as shorthand for the equivalent builder calls.
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
 *
 * @example
 * ```ts
 * const rule = select('src/**\/*.ts', {
 *   exclude: ['**\/*.test.ts'],
 *   label: 'No `any` types',
 *   category: 'strictness',
 * }).check(noTypedAny());
 * ```
 */
export function select(...patternsOrOptions: (string | SelectOptions)[]): Selector {
  const options = patternsOrOptions.find(
    (value): value is SelectOptions => typeof value === 'object' && value !== null,
  );
  const patterns = patternsOrOptions.filter((value): value is string => typeof value === 'string');

  return createSelector({
    patterns: [...patterns, ...asArray(options?.include)],
    exclusions: asArray(options?.exclude),
    predicates: [],
    humanLabel: options?.label ?? null,
    category: options?.category,
    guidance: options?.guidance,
  });
}

/**
 * Applies one category to a list of rules.
 *
 * Lets a config group rules by category without repeating `.category(...)` on
 * every rule or restating the category as a comment:
 *
 * @example
 * ```ts
 * rules: [
 *   ...group('strictness', [noAny, noEnums, noNonNullAssertions]),
 *   ...group('cleanup', [noConsole, noTrivialComments]),
 * ]
 * ```
 */
export function group(category: RuleCategory, rules: readonly Rule[]): Rule[] {
  return rules.map((rule) => ({ ...rule, category }));
}

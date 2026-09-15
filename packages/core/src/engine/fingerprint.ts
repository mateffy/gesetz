import { hashValue } from '../cache';
import type { SyntaxBackend } from '../services/syntax-tree';
import type { Rule } from './rule';

/**
 * Validity material for a rule's cached results.
 *
 * A change to anything that affects a rule's output MUST change this string;
 * that is the only signal the cache has. `fn.toString()` is used for check
 * bodies because JavaScript offers no structural identity for closures — a
 * check that closes over mutable configuration must either embed that
 * configuration in the produced function source (as the built-in factories do,
 * since their options appear in their messages) or supply an explicit
 * `rule.fingerprint`.
 */
export function ruleFingerprint(rule: Rule): string {
  if (rule.fingerprint !== undefined && rule.fingerprint !== '') return rule.fingerprint;
  return hashValue({
    v: 1,
    id: rule.id,
    category: rule.category ?? null,
    perFile:
      rule.perFile === undefined
        ? null
        : {
            patterns: rule.perFile.patterns,
            exclusions: rule.perFile.exclusions,
            checks: rule.perFile.checks.map((fn) => fn.toString()),
            predicates: rule.perFile.predicates.map((fn) => fn.toString()),
          },
    project: rule.project === undefined ? null : rule.project.patterns,
  });
}

/**
 * Validity material for cached results that depend on syntax extraction.
 *
 * The backend object itself is not hashable, so its extractor sources are used:
 * a change to extraction logic changes the produced source text. Backends whose
 * behaviour is configured at runtime should either encode that configuration in
 * the extractor source or be paired with an explicit version bump.
 */
export function backendFingerprint(backends: readonly SyntaxBackend[]): string {
  return hashValue(
    backends.map((backend) => ({
      extensions: [...backend.extensions],
      imports: backend.extractImports.toString(),
      calls: backend.extractCalls.toString(),
      exports: backend.extractExports.toString(),
      structure: backend.extractStructure.toString(),
    })),
  );
}

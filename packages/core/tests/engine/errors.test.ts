import { describe, it, expect } from 'vitest';
import {
  ExecError,
  FileReadError,
  GlobError,
  PhpstanError,
  ReporterError,
  RuleError,
} from '../../src/engine/errors';

describe('tagged errors', () => {
  it('carries the tag the runner and adapters switch on', () => {
    // The `_tag` is a runtime contract: adapters and the CLI branch on it, so a
    // rename is a breaking change rather than a cosmetic one.
    expect(new FileReadError({ path: '/a', cause: 'x' })._tag).toBe('FileReadError');
    expect(new GlobError({ pattern: '**/*', cause: 'x' })._tag).toBe('GlobError');
    expect(new RuleError({ ruleId: 'r', cause: 'x' })._tag).toBe('RuleError');
    expect(new PhpstanError({ cause: 'x' })._tag).toBe('PhpstanError');
    expect(new ExecError({ command: 'tool', cause: 'x' })._tag).toBe('ExecError');
    expect(new ReporterError({ cause: 'x' })._tag).toBe('ReporterError');
  });

  it('keeps the fields the caller needs to report the failure', () => {
    const e = new FileReadError({ path: '/etc/app.json', cause: new Error('ENOENT') });
    expect(e.path).toBe('/etc/app.json');
    expect(String(e.cause)).toContain('ENOENT');
  });

  it('accepts several patterns for a glob failure', () => {
    const e = new GlobError({ pattern: ['a/**', 'b/**'], cause: 'bad' });
    expect(e.pattern).toEqual(['a/**', 'b/**']);
  });

  it('is an Error, so it can be thrown and caught normally', () => {
    const e = new RuleError({ ruleId: 'x', cause: 'y' });
    expect(e).toBeInstanceOf(Error);
  });

  it('keeps phpstan stdout when it is supplied', () => {
    const e = new PhpstanError({ cause: 'bad exit', stdout: '{"files":{}}' });
    expect(e.stdout).toBe('{"files":{}}');
  });
});

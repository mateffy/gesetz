import { Data } from 'effect';

export class FileReadError extends Data.TaggedError('FileReadError')<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export class GlobError extends Data.TaggedError('GlobError')<{
  readonly pattern: string | string[];
  readonly cause: unknown;
}> {}

export class RuleError extends Data.TaggedError('RuleError')<{
  readonly ruleId: string;
  readonly cause: unknown;
}> {}

export class PhpstanError extends Data.TaggedError('PhpstanError')<{
  readonly cause: unknown;
  readonly stdout?: string | undefined;
}> {}

export class ExecError extends Data.TaggedError('ExecError')<{
  readonly command: string;
  readonly cause: unknown;
}> {}

export class TsAdapterError extends Data.TaggedError('TsAdapterError')<{
  readonly cause: unknown;
}> {}

export class PhpAdapterError extends Data.TaggedError('PhpAdapterError')<{
  readonly message: string;
}> {}

export class ReporterError extends Data.TaggedError('ReporterError')<{
  readonly cause: unknown;
}> {}

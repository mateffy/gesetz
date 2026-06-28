// PHP SyntaxBackend (@ast-grep/lang-php). Replaces the old tree-sitter PhpAdapterLive.
export { phpSyntaxBackend } from './syntax-backend';

// PHP check primitives
export {
  strictTypes,
  psrNamespace,
  noInlineQueries,
  requireTypeHints,
  requireReturnType,
  requireNamespace,
  noDieOrExit,
  noEval,
  requireFinalClasses,
} from './checks';
export type {
  RequireTypeHintsOptions,
  RequireReturnTypeOptions,
  RequireNamespaceOptions,
  NoDieOrExitOptions,
  NoEvalOptions,
  RequireFinalClassesOptions,
} from './checks';

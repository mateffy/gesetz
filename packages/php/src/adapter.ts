/**
 * PHP parsing is now handled by `phpSyntaxBackend` in `./syntax-backend.ts`
 * (using `@ast-grep/lang-php`).
 *
 * The old `PhpAdapterLive` (tree-sitter-php) is deleted. `PhpAdapter` /
 * `PhpAdapterStub` remain in `@gesetz/core` as no-op stubs because several
 * out-of-scope adapter packages import them in their tests.
 *
 * This file is kept as a marker so old imports of `./adapter` surface a clear
 * "module not found" if anything still references it.
 */
export {};

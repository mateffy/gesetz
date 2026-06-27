/**
 * Laravel-specific checks for /laravel.
 *
 * Builds on /php primitives with Laravel-opinionated defaults.
 * All checks here assume a standard Laravel project structure.
 */
import { select } from '@gesetz/core';
import { strictTypes, psrNamespace, noInlineQueries } from '@gesetz/php';
import type { Rule } from '@gesetz/core';

// ─── declare strict_types=1 ───────────────────────────────────────────────────

/**
 * All PHP files in a Laravel project must declare strict_types=1.
 *
 * Guidance:
 * - **What**: Missing declare(strict_types=1) weakens type coercion guarantees.
 * - **Do**: Add `declare(strict_types=1);` as the second line of every PHP file.
 * - **Don't**: Omit it to avoid refactoring — fix the coercions instead.
 */
export const requireStrictTypes: Rule = select('app/**/*.php', 'src/**/*.php')
  .label('All PHP files must declare strict_types=1')
  .category('strictness')
  .guidance({
    what: 'PHP files without strict_types=1 allow silent type coercion.',
    do: 'Add declare(strict_types=1); as the first statement after <?php.',
    dont: 'Omit it — PHP will silently coerce types in unexpected ways.',
  })
  .check(strictTypes());

// ─── PSR-4 namespace discipline ───────────────────────────────────────────────

/**
 * Laravel models in app/Domains must follow PSR-4 namespace conventions.
 *
 * Guidance:
 * - **What**: Namespace doesn't match directory structure.
 * - **Do**: Keep namespace consistent with file path under app/ → App\.
 * - **Don't**: Use arbitrary namespaces that don't match the directory.
 */
export const requirePsrNamespaces: Rule = select('app/**/*.php')
  .label('PHP namespaces must follow PSR-4 conventions (App\\ → app/)')
  .category('organization')
  .guidance({
    what: 'Namespace does not match the file path per PSR-4.',
    do: 'Match namespace to directory: app/Domains/Foo/Bar.php → namespace App\\Domains\\Foo.',
    dont: 'Write arbitrary namespaces — autoloading will silently fail.',
  })
  .check(psrNamespace({ baseNamespace: 'App', basePath: 'app' }));

// ─── No raw DB queries ────────────────────────────────────────────────────────

/**
 * No raw SQL strings using Laravel's DB facade.
 * Encourages Eloquent over raw queries.
 *
 * Guidance:
 * - **What**: Direct DB::statement() / DB::raw() / DB::select() calls bypass Eloquent.
 * - **Do**: Use Eloquent query builder methods or parameterized query builders.
 * - **Don't**: Write raw SQL strings — they're injection-prone and skip model events.
 */
export const noRawDbQueries: Rule = select('app/**/*.php')
  .exclude('app/Console/**', 'database/**')
  .label('No raw DB queries — use Eloquent instead')
  .category('security')
  .guidance({
    what: 'Raw DB::statement() or DB::raw() calls bypass the Eloquent ORM.',
    do: 'Use Eloquent model methods and the query builder.',
    dont: 'Call DB::statement() or DB::raw() in application code.',
  })
  .check(noInlineQueries(['DB::statement', 'DB::raw', 'DB::unprepared', 'DB::select']));

// ─── No env() outside config ──────────────────────────────────────────────────

/**
 * env() calls must only appear in config/ files.
 *
 * Guidance:
 * - **What**: env() bypasses the config cache, breaking Laravel's `php artisan config:cache`.
 * - **Do**: Read environment variables only in config/ files; use config('key') elsewhere.
 * - **Don't**: Call env() in app/, routes/, or resources/.
 */
export const noEnvOutsideConfig: Rule = select(
  'app/**/*.php',
  'routes/**/*.php',
  'resources/**/*.php',
)
  .label('env() must only be called in config/ files')
  .category('structure')
  .guidance({
    what: 'env() called outside config/ breaks the Laravel config cache.',
    do: "Add an entry to the appropriate config file and use config('app.my_key') instead.",
    dont: "Call env('MY_KEY') directly in app/ or routes/ — it breaks config:cache.",
  })
  .check(
    noInlineQueries(['env('], {
      message: "env() called outside config/. Use config('...') instead — env() breaks config caching.",
    }),
  );

// ─── No dd() / dump() in production ──────────────────────────────────────────

/**
 * Bans Laravel debug helpers (dd, dump, ddd, ray) in production code.
 *
 * Guidance:
 * - **What**: Laravel's dd(), dump(), ddd(), ray() are debugging helpers.
 * - **Do**: Remove all dd/dump calls before committing.
 * - **Don't**: Leave debug dumps in committed code.
 */
export const noDebugHelpers: Rule = select('app/**/*.php', 'routes/**/*.php')
  .label('No dd/dump/ray debug helpers in application code')
  .category('cleanup')
  .guidance({
    what: 'dd(), dump(), ddd(), ray() are Laravel debug helpers left in production code.',
    do: 'Remove all debug helpers before committing.',
    dont: 'Leave dd() or dump() calls in committed code.',
  })
  .check(
    noInlineQueries(['dd(', 'dump(', 'ddd(', 'ray('], {
      message: 'Debug helper (dd/dump/ddd/ray) left in code — remove before committing.',
    }),
  );

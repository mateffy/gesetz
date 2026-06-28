import { describe, it, expect } from 'vitest';
import { phpSyntaxBackend } from '../src/syntax-backend';

const PHP = `<?php
declare(strict_types=1);

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Support\\Facades\\{Auth, DB};
use App\\Traits\\HasUuid as Uuid;

class User extends Model {
    /** Get the user's name. */
    public function getName(): string {
        var_dump($x);
        return $this->name;
    }

    private function helper(): void {}
}

function standalone(int $x): void {
    dumpx($y);
}

/** Doc for top-level fn */
function documented(): int { return 1; }`;

// Skip the whole suite if @ast-grep/lang-php is not installed.
const hasPhp = (() => {
  try {
    // touch the backend so registration is attempted
    phpSyntaxBackend.extractImports('<?php echo 1;', 't.php');
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(hasPhp)('phpSyntaxBackend', () => {
  describe('extensions', () => {
    it('handles .php', () => {
      expect(phpSyntaxBackend.extensions).toEqual(['.php']);
    });
  });

  describe('extractImports', () => {
    it('parses namespace_use_declaration into clean specifiers', () => {
      const imports = phpSyntaxBackend.extractImports(PHP, 'User.php');
      const specifiers = imports.map((i) => i.specifier);
      expect(specifiers).toContain('Illuminate\\Database\\Eloquent\\Model');
      expect(specifiers).toContain('App\\Traits\\HasUuid');
    });

    it('expands grouped use {A, B} into individual clauses', () => {
      const imports = phpSyntaxBackend.extractImports(PHP, 'User.php');
      const specifiers = imports.map((i) => i.specifier);
      // Grouped `use Illuminate\Support\Facades\{Auth, DB}` → Auth + DB
      // (ast-grep emits namespace_use_clause nodes per name in the group).
      expect(specifiers).toContain('Auth');
      expect(specifiers).toContain('DB');
    });

    it('strips `as Alias` from the specifier', () => {
      const imports = phpSyntaxBackend.extractImports(PHP, 'User.php');
      // `use App\Traits\HasUuid as Uuid;` → specifier is "App\Traits\HasUuid"
      expect(imports).toContainEqual(
        expect.objectContaining({ specifier: 'App\\Traits\\HasUuid' }),
      );
      // The alias "Uuid" must NOT appear as a specifier on its own.
      const specifiers = imports.map((i) => i.specifier);
      expect(specifiers).not.toContain('Uuid');
    });

    it('returns [] for unparseable input', () => {
      const imports = phpSyntaxBackend.extractImports('@@@ not php @@@', 'bad.php');
      expect(imports).toEqual([]);
    });
  });

  describe('extractCalls', () => {
    it('finds function calls', () => {
      const calls = phpSyntaxBackend.extractCalls(PHP, 'User.php');
      const names = calls.map((c) => c.name);
      expect(names).toContain('var_dump');
      expect(names).toContain('dumpx');
    });

    it('reports 1-indexed line numbers', () => {
      const calls = phpSyntaxBackend.extractCalls(PHP, 'User.php');
      const vd = calls.find((c) => c.name === 'var_dump');
      expect(typeof vd?.line).toBe('number');
      expect(vd?.line).toBeGreaterThan(0);
    });
  });

  describe('extractExports', () => {
    it('always returns [] (PHP has no explicit export syntax)', () => {
      expect(phpSyntaxBackend.extractExports(PHP, 'User.php')).toEqual([]);
    });
  });

  describe('extractStructure', () => {
    it('finds class and top-level function declarations', () => {
      const items = phpSyntaxBackend.extractStructure(PHP, 'User.php', false);
      const classes = items.filter((i) => i.kind === 'class');
      const fns = items.filter((i) => i.kind === 'function');
      expect(classes.map((c) => c.name)).toContain('User');
      expect(fns.map((f) => f.name)).toContain('standalone');
      expect(fns.map((f) => f.name)).toContain('documented');
    });

    it('attaches methods as children of classes', () => {
      const items = phpSyntaxBackend.extractStructure(PHP, 'User.php', false);
      const cls = items.find((i) => i.kind === 'class' && i.name === 'User');
      const methodNames = cls?.children.map((c) => c.name);
      expect(methodNames).toContain('getName');
      expect(methodNames).toContain('helper');
      expect(cls?.children.every((c) => c.kind === 'method')).toBe(true);
    });

    it('extracts docstrings when includeDocstrings is true', () => {
      const items = phpSyntaxBackend.extractStructure(PHP, 'User.php', true);
      const getName = items
        .find((i) => i.kind === 'class' && i.name === 'User')
        ?.children.find((c) => c.name === 'getName');
      expect(getName?.docstring).toContain("Get the user's name.");

      const documented = items.find((i) => i.kind === 'function' && i.name === 'documented');
      expect(documented?.docstring).toContain('Doc for top-level fn');
    });

    it('returns null docstrings when includeDocstrings is false', () => {
      const items = phpSyntaxBackend.extractStructure(PHP, 'User.php', false);
      const getName = items
        .find((i) => i.kind === 'class' && i.name === 'User')
        ?.children.find((c) => c.name === 'getName');
      expect(getName?.docstring).toBeNull();
    });

    it('returns [] for unparseable input', () => {
      expect(phpSyntaxBackend.extractStructure('@@@ bad', 'bad.php', false)).toEqual([]);
    });
  });
});

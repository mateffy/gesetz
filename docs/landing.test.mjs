// Run from the repository root: node --test docs/landing.test.mjs
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { test } from 'node:test';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const data = html.match(/<script id="examples" type="application\/json">([\s\S]*?)<\/script>/);
assert.ok(data, 'The landing page must contain its copyable, verifiable examples.');
const examples = JSON.parse(data[1]);

const require = createRequire(new URL('../packages/cli/package.json', import.meta.url));
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { tryNative: false, fsCache: false });

// Load the real checks without starting the CLI or its persistent cache.
const api = Object.assign({}, ...await Promise.all([
  '../packages/core/src/engine/config.ts',
  '../packages/core/src/primitives/select.ts',
  '../packages/core/src/primitives/checks/imports.ts',
  '../packages/core/src/primitives/checks/fs.ts',
  '../packages/core/src/primitives/checks/debug-logging.ts',
].map(path => jiti.import(path))));
const { makeFile, makeCheckServices } = await jiti.import('../packages/core/src/test-helpers.ts');
const coreRequire = createRequire(new URL('../packages/core/package.json', import.meta.url));
const micromatch = coreRequire('micromatch');
const publicExports = await readFile(new URL('../packages/core/src/index.ts', import.meta.url), 'utf8');

function loadExample(config) {
  const declaration = config.match(/import\s*\{([^}]+)\}\s*from 'gesetz';/);
  assert.ok(declaration, 'Every config imports the public gesetz API.');
  const names = declaration[1].split(',').map(name => name.trim()).filter(Boolean);
  for (const name of names) {
    assert.equal(typeof api[name], 'function', `Unknown import: ${name}`);
    assert.match(publicExports, new RegExp(`\\b${name}\\b`));
  }
  const body = config.replace(declaration[0], '').replace('export default', 'return');
  return new Function(...names, body)(...names.map(name => api[name]));
}

for (const example of examples) {
  for (const version of ['before', 'after']) {
    test(`${example.id}: the ${version} result matches the real checks`, async () => {
      const config = loadExample(example.config);
      const state = example[version];
      const files = Object.entries(state.files).map(([path, content]) => makeFile(path, content));
      const services = makeCheckServices({
        files: Object.fromEntries(files.map(file => [file.absolutePath, file.content])),
        overrides: { syntax: { canProcess: () => false } },
      });
      const actual = [];
      for (const rule of config.rules) {
        assert.equal(rule.category, example.category);
        assert.equal(rule.id, example.ruleId);
        assert.ok(rule.perFile);
        const selected = files.filter(file =>
          micromatch.isMatch(file.path, rule.perFile.patterns)
          && !micromatch.isMatch(file.path, rule.perFile.exclusions),
        );
        for (const file of selected) {
          for (const check of rule.perFile.checks) {
            actual.push(...await check(file, services));
          }
        }
      }
      assert.deepEqual(actual, state.violations);
      const weights = { error: 1, warn: 0.5, info: 0.1 };
      const score = Math.max(0, Math.round((10 - actual.reduce((n, v) => n + weights[v.severity], 0)) * 10) / 10);
      assert.equal(state.score, score);
      assert.equal(state.score >= 10, version === 'after');
      assert.equal(actual.length, version === 'after' ? 0 : 1);
    });
  }
}

test('the initial example is readable without JavaScript', () => {
  assert.ok(html.includes(examples[0].config));
  assert.ok(html.includes(examples[0].before.files[examples[0].path]));
  assert.ok(html.includes(examples[0].before.violations[0].message));
  assert.match(html, /id="result-score">9\.0</);
  assert.match(html, /id="result-verdict">Fail</);
});

test('all local links and assets resolve, and the page script parses', async () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size, 'Duplicate element IDs');
  for (const [, href] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    if (href.startsWith('#')) assert.ok(ids.includes(href.slice(1)), `Broken anchor ${href}`);
    else if (!/^(https?:|data:)/.test(href)) await access(new URL(href, import.meta.url));
  }
  const script = await readFile(new URL('./site.js', import.meta.url), 'utf8');
  new Script(script, { filename: 'docs/site.js' });
  const css = await readFile(new URL('./tokens.css', import.meta.url), 'utf8');
  for (const [, path] of css.matchAll(/url\("([^"\)]+)"\)/g)) {
    await access(new URL(path, import.meta.url));
  }
});

import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';
import { noLiteralJsxText, noLiteralJsxProp, noJsxElements } from '../src';

const file = (source: string, name = 'src/Foo.tsx') => makeFile(name, source);

describe('noLiteralJsxText', () => {
  it('flags hardcoded text in JSX', async () => {
    const v = await runCheck(noLiteralJsxText(), file('const A = () => <p>Hello</p>;'), makeCheckServices());
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
    expect(v[0]?.message).toContain('Raw text in JSX');
  });

  it('accepts text with no letters, which needs no translation', async () => {
    const v = await runCheck(noLiteralJsxText(), file('const A = () => <p>123</p>;'), makeCheckServices());
    expect(v).toHaveLength(0);
  });

  it('accepts an expression rather than literal text', async () => {
    const v = await runCheck(noLiteralJsxText(), file('const A = () => <p>{t("hello")}</p>;'), makeCheckServices());
    expect(v).toHaveLength(0);
  });

  it('flags German text as well as English', async () => {
    const v = await runCheck(noLiteralJsxText(), file('const A = () => <p>Wohnung</p>;'), makeCheckServices());
    expect(v).toHaveLength(1);
  });

  it('honours a custom letter regex', async () => {
    const v = await runCheck(
      noLiteralJsxText({ hasLetterRegex: /[A-Z]/ }),
      file('const A = () => <p>lower</p>;'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('accepts a file with no JSX', async () => {
    expect(await runCheck(noLiteralJsxText(), file('const x = 1;'), makeCheckServices())).toHaveLength(0);
  });
});

describe('noLiteralJsxProp', () => {
  it('flags a hardcoded value on a translatable prop', async () => {
    const v = await runCheck(
      noLiteralJsxProp(['title']),
      file('const A = () => <Button title="Hello" />;'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('title');
  });

  it('accepts the prop when its value is an expression', async () => {
    const v = await runCheck(
      noLiteralJsxProp(['title']),
      file('const A = () => <Button title={t("hello")} />;'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it('accepts props that are not on the list', async () => {
    const v = await runCheck(
      noLiteralJsxProp(['title']),
      file('const A = () => <Button className="btn" />;'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });
});

describe('noJsxElements', () => {
  it('flags a listed element', async () => {
    const v = await runCheck(noJsxElements(['div']), file('const A = () => <div />;'), makeCheckServices());
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
  });

  it('flags a listed opening element with children', async () => {
    const v = await runCheck(noJsxElements(['div']), file('const A = () => <div>x</div>;'), makeCheckServices());
    expect(v).toHaveLength(1);
  });

  it('flags an unrelated element containing a listed one', async () => {
    const v = await runCheck(noJsxElements(['span']), file('const A = () => <p><span /></p>;'), makeCheckServices());
    expect(v).toHaveLength(1);
  });

  it('accepts elements that are not listed', async () => {
    expect(await runCheck(noJsxElements(['div']), file('const A = () => <section />;'), makeCheckServices())).toHaveLength(0);
  });

  it('accepts a file that does not parse, without throwing', async () => {
    const v = await runCheck(noJsxElements(['div']), file('<div'), makeCheckServices());
    expect(Array.isArray(v)).toBe(true);
  });
});

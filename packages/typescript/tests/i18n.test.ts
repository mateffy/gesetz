import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';
import { noHardcodedStrings } from '../src';

describe('noHardcodedStrings', () => {
  function tsx(content: string) {
    return makeFile('src/Comp.tsx', content);
  }

  describe('Case 1: raw JSX text children', () => {
    it('flags raw JSX text with letters', async () => {
      const v = await runCheck(noHardcodedStrings(), tsx('const X = () => <div>Hello world</div>;'), makeCheckServices());
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('Hello world');
      expect(v[0]?.severity).toBe('error');
    });

    it('ignores whitespace/punctuation-only JSX text', async () => {
      const v = await runCheck(noHardcodedStrings(), tsx('const X = () => <div>   ... --- </div>;'), makeCheckServices());
      expect(v).toHaveLength(0);
    });

    it('flags JSX text nested inside elements', async () => {
      const v = await runCheck(noHardcodedStrings(), tsx('const X = () => <nav><a href="/">Home</a></nav>;'), makeCheckServices());
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('Home');
    });
  });

  describe('Case 2: allowlisted translatable props', () => {
    it('flags placeholder with a string literal', async () => {
      const v = await runCheck(noHardcodedStrings(), tsx('const X = () => <input placeholder="Search" />;'), makeCheckServices());
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('placeholder');
      expect(v[0]?.severity).toBe('warn');
    });

    it('flags label, title, aria-label, heading, description, helperText, hint', async () => {
      const src = `
        const X = () => (
          <>
            <Button label="Save" />
            <Box title="Details" />
            <input aria-label="Email" />
            <Card heading="Welcome" />
            <Card description="Manage your account" />
            <Field helperText="Required" />
            <Field hint="Optional" />
          </>
        );
      `;
      const v = await runCheck(noHardcodedStrings(), tsx(src), makeCheckServices());
      expect(v).toHaveLength(7);
      const props = v.map((x) => x.message).sort();
      expect(props).toEqual([
        "Prop 'aria-label'=\"Email\" should use a translation API",
        "Prop 'description'=\"Manage your account\" should use a translation API",
        "Prop 'heading'=\"Welcome\" should use a translation API",
        "Prop 'helperText'=\"Required\" should use a translation API",
        "Prop 'hint'=\"Optional\" should use a translation API",
        "Prop 'label'=\"Save\" should use a translation API",
        "Prop 'title'=\"Details\" should use a translation API",
      ].sort());
    });

    it('ignores allowlisted props whose value has no letters', async () => {
      const v = await runCheck(noHardcodedStrings(), tsx('const X = () => <Box title="..." />;'), makeCheckServices());
      expect(v).toHaveLength(0);
    });

    it('ignores allowlisted props with expression-container values', async () => {
      const v = await runCheck(noHardcodedStrings(), tsx('const X = () => <input placeholder={m.search()} />;'), makeCheckServices());
      expect(v).toHaveLength(0);
    });
  });

  describe('MUST NOT flag (regression cases from immoui)', () => {
    it('does not flag Tailwind / cn() utility classes in JSX expressions', async () => {
      const v = await runCheck(noHardcodedStrings(), tsx('const X = () => <div className={cn("flex items-end gap-0 overflow-x-auto")}>Hi</div>;'), makeCheckServices());
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('Hi');
    });

    it('does not flag className with a raw string literal', async () => {
      const v = await runCheck(noHardcodedStrings(), tsx('const X = () => <img className="h-8 w-8" alt="avatar" />;'), makeCheckServices());
      expect(v).toHaveLength(0);
    });

    it('does not flag component enum-like props (sizes, variant, value)', async () => {
      const v = await runCheck(noHardcodedStrings(), tsx('const X = () => (<><Button sizes="sm" /><Button variant="outline" /><Toggle value="stacking" /><Toggle value="floorplan" /></>);'), makeCheckServices());
      expect(v).toHaveLength(0);
    });

    it('does not flag route paths / URLs in props (to, href)', async () => {
      const v = await runCheck(noHardcodedStrings(), tsx('const X = () => (<><Link to="/companies/$companyId" /><Link to="/companies" /><a href="https://example.com">Site</a></>);'), makeCheckServices());
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('Site');
    });

    it('does not flag strings inside JSX expression containers at all', async () => {
      const v = await runCheck(noHardcodedStrings(), tsx('const X = () => <div data-key={"stacking"}>Hi</div>;'), makeCheckServices());
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('Hi');
    });

    it('does not flag icon/image CSS classes on avatar components', async () => {
      const v = await runCheck(noHardcodedStrings(), tsx('const X = () => <img className="h-full w-full object-contain" />;'), makeCheckServices());
      expect(v).toHaveLength(0);
    });
  });

  describe('options', () => {
    it('respects a custom textAttributes allowlist', async () => {
      const v = await runCheck(noHardcodedStrings({ textAttributes: ['placeholder'] }), tsx('const X = () => (<><input placeholder="Search" /><Box label="Name" /></>);'), makeCheckServices());
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('placeholder');
    });

    it('respects attributeSeverity override', async () => {
      const v = await runCheck(noHardcodedStrings({ attributeSeverity: 'error' }), tsx('const X = () => <input placeholder="Search" />;'), makeCheckServices());
      expect(v[0]?.severity).toBe('error');
    });
  });
});
import { describe, expect, it } from 'vitest';
import {
  MAX_REQUEST_BYTES,
  decodeRequest,
  decodeResponse,
  encodeLine,
  isDecodeError,
} from '../../../src/engine/daemon/protocol';

const spec = {
  instanceKey: 'abc',
  scope: { files: ['src/**'], since: null },
  rules: ['tsc'],
  categories: null,
  baseline: 'apply',
} as const;

describe('encodeLine', () => {
  it('produces exactly one newline-terminated JSON line', () => {
    const line = encodeLine({ v: 1, id: 'x', kind: 'status' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n')).toHaveLength(2);
    expect(JSON.parse(line)).toEqual({ v: 1, id: 'x', kind: 'status' });
  });
});

describe('decodeRequest', () => {
  it('round-trips a status request', () => {
    const decoded = decodeRequest(encodeLine({ v: 1, id: 'a', kind: 'status' }).trimEnd());
    expect(isDecodeError(decoded)).toBe(false);
    expect(decoded).toEqual({ v: 1, id: 'a', kind: 'status' });
  });

  it('round-trips a check request with its whole spec', () => {
    const decoded = decodeRequest(encodeLine({ v: 1, id: 'a', kind: 'check', spec, waitMs: 50 }).trimEnd());
    expect(decoded).toEqual({ v: 1, id: 'a', kind: 'check', spec, waitMs: 50 });
  });

  it('copies the spec rather than aliasing the caller’s arrays', () => {
    const files = ['src/**'];
    const decoded = decodeRequest(
      encodeLine({
        v: 1,
        id: 'a',
        kind: 'check',
        spec: { ...spec, scope: { files, since: null } },
        waitMs: 0,
      }).trimEnd(),
    );
    if (isDecodeError(decoded) || decoded.kind !== 'check') throw new Error('expected a check');
    expect(decoded.spec.scope.files).toEqual(['src/**']);
    expect(decoded.spec.scope.files).not.toBe(files);
  });

  it.each([
    ['not JSON', '{oops'],
    ['not an object', '42'],
    ['a wrong version', '{"v":2,"id":"a","kind":"status"}'],
    ['a missing id', '{"v":1,"kind":"status"}'],
    ['an unknown kind', '{"v":1,"id":"a","kind":"wat"}'],
    [
      'a spec that is not an object',
      '{"v":1,"id":"a","kind":"check","spec":"x","waitMs":0}',
    ],
    [
      'a missing instance key',
      '{"v":1,"id":"a","kind":"check","spec":{"scope":{"files":null,"since":null},"rules":null,"categories":null,"baseline":"apply"},"waitMs":0}',
    ],
    [
      'a bad baseline mode',
      '{"v":1,"id":"a","kind":"check","spec":{"instanceKey":"k","scope":{"files":null,"since":null},"rules":null,"categories":null,"baseline":"maybe"},"waitMs":0}',
    ],
    [
      'a negative wait',
      '{"v":1,"id":"a","kind":"check","spec":{"instanceKey":"k","scope":{"files":null,"since":null},"rules":null,"categories":null,"baseline":"apply"},"waitMs":-1}',
    ],
  ])('refuses %s, naming the problem instead of throwing', (_label, line) => {
    const decoded = decodeRequest(line);
    expect(isDecodeError(decoded)).toBe(true);
    if (!isDecodeError(decoded)) throw new Error('expected an error');
    expect(decoded.error.length).toBeGreaterThan(0);
  });

  it('refuses a request over the size cap rather than parsing it', () => {
    const decoded = decodeRequest('x'.repeat(MAX_REQUEST_BYTES + 1));
    expect(isDecodeError(decoded) && decoded.error).toContain('over the');
  });
});

describe('decodeResponse', () => {
  const ok = { v: 1, id: 'a', ok: true, envelope: { total: 1 }, servedFrom: 'recomputed', checksNotRun: [], computedAt: 5 };

  it('round-trips a successful response with its opaque envelope', () => {
    expect(decodeResponse(encodeLine(ok).trimEnd())).toEqual(ok);
  });

  it('round-trips an error response', () => {
    expect(decodeResponse(encodeLine({ v: 1, id: 'a', ok: false, error: 'boom' }).trimEnd())).toEqual({
      v: 1,
      id: 'a',
      ok: false,
      error: 'boom',
    });
  });

  it.each([
    ['a bad servedFrom', { ...ok, servedFrom: 'guessed' }],
    ['a missing computedAt', { ...ok, computedAt: undefined }],
    ['checksNotRun that is not an array', { ...ok, checksNotRun: 'none' }],
    ['a missing ok', { v: 1, id: 'a' }],
  ])('refuses %s', (_label, value) => {
    const decoded = decodeResponse(JSON.stringify(value));
    expect(isDecodeError(decoded)).toBe(true);
  });

  it('does not mistake an error response for a malformed line', () => {
    // `ok: false` is a valid answer: the daemon looked and could not do the work.
    // Treating it as a protocol error would lose the message it went to the trouble
    // of producing.
    const decoded = decodeResponse(encodeLine({ v: 1, id: 'a', ok: false, error: 'boom' }).trimEnd());
    expect(isDecodeError(decoded)).toBe(false);
  });
});

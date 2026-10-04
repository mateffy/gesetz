import { describe, expect, it } from 'vitest';
import * as nodePath from 'node:path';
import { MAX_SOCKET_PATH, removeSocketFile, socketExists, socketPathFor } from '../../../src/engine/daemon/lifecycle';

describe('socketPathFor', () => {
  it('keeps the socket beside the project state when the path is short enough', () => {
    expect(socketPathFor('/tmp/proj')).toBe(nodePath.join('/tmp/proj', '.gesetz', 'daemon.sock'));
  });

  it('moves to the temp directory when the path would not fit in sun_path', () => {
    // `bind` fails on a path over the limit with a message that says nothing about
    // length, so this is decided here rather than discovered in the field.
    const root = nodePath.join('/tmp', 'a'.repeat(200));
    const path = socketPathFor(root);
    expect(path.length).toBeLessThanOrEqual(MAX_SOCKET_PATH);
    expect(path).not.toContain(root);
    expect(path.endsWith('.sock')).toBe(true);
  });

  it('is deterministic, so a client computes the same path as the server', () => {
    const root = nodePath.join('/tmp', 'b'.repeat(200));
    expect(socketPathFor(root)).toBe(socketPathFor(root));
  });

  it('gives two long roots different sockets', () => {
    const one = socketPathFor(nodePath.join('/tmp', 'c'.repeat(200), 'one'));
    const two = socketPathFor(nodePath.join('/tmp', 'c'.repeat(200), 'two'));
    expect(one).not.toBe(two);
  });
});

describe('socket files', () => {
  it('is idempotent when removing something that is not there', () => {
    expect(() => removeSocketFile(nodePath.join('/tmp', 'gesetz-not-a-real-socket.sock'))).not.toThrow();
  });

  it('does not report a missing socket as existing', () => {
    expect(socketExists(nodePath.join('/tmp', 'gesetz-not-a-real-socket.sock'))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { resolveDaemonMode } from '../src/daemon-mode';

const base = { configDaemon: undefined, flagDaemon: false, flagNoDaemon: false, flagStandalone: false } as const;

describe('resolveDaemonMode: the precedence table', () => {
  it('is off by default, with no config and no flags', () => {
    expect(resolveDaemonMode(base)).toBe('off');
  });

  it('is on when the config opts in', () => {
    expect(resolveDaemonMode({ ...base, configDaemon: true })).toBe('on');
  });

  it('is off when the config says so', () => {
    expect(resolveDaemonMode({ ...base, configDaemon: false })).toBe('off');
  });

  it('lets --daemon override a config that says off', () => {
    expect(resolveDaemonMode({ ...base, configDaemon: false, flagDaemon: true })).toBe('on');
  });

  it('lets --no-daemon override a config that says on', () => {
    expect(resolveDaemonMode({ ...base, configDaemon: true, flagNoDaemon: true })).toBe('off');
  });

  it('lets --no-daemon beat --daemon, because the two together mean stop', () => {
    expect(resolveDaemonMode({ ...base, flagDaemon: true, flagNoDaemon: true })).toBe('off');
  });

  it('lets --standalone mean off, since a daemon contradicts one process and one run', () => {
    expect(resolveDaemonMode({ ...base, configDaemon: true, flagStandalone: true })).toBe('off');
  });

  it('lets an explicit --daemon beat --standalone, the more specific instruction', () => {
    expect(resolveDaemonMode({ ...base, flagDaemon: true, flagStandalone: true })).toBe('on');
  });
});

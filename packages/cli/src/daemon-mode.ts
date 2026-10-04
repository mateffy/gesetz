/**
 * Whether a run should ask a daemon, decided in one place.
 *
 * Three ways to say it (a config switch and two flags), plus the existing
 * `--standalone` escape hatch, need one order of precedence that is written down and
 * tested — otherwise the answer depends on which code path a run happens to take.
 */

export type DaemonMode = 'on' | 'off';

/**
 * The precedence, first match wins:
 *
 * 1. `--no-daemon`   — off, whatever the config says.
 * 2. `--daemon`      — on, whatever the config says.
 * 3. `--standalone`  — off. It means "one process, one run, no waiting and no reuse",
 *                      which a daemon would contradict.
 * 4. config `daemon: true` — on.
 * 5. otherwise       — off.
 *
 * `--daemon` beating `--standalone` is deliberate: asking for a daemon explicitly is
 * more specific than the general "leave me alone" escape hatch. A run with both is
 * contradictory, and the specific instruction should win.
 *
 * "On" means *use* a daemon if one is running. Nothing here starts one: that is
 * `gesetz daemon start`, because a background process nobody asked for outlives the
 * command that summoned it.
 */
export function resolveDaemonMode(input: {
  readonly configDaemon: boolean | undefined;
  readonly flagDaemon: boolean;
  readonly flagNoDaemon: boolean;
  readonly flagStandalone: boolean;
}): DaemonMode {
  if (input.flagNoDaemon) return 'off';
  if (input.flagDaemon) return 'on';
  if (input.flagStandalone) return 'off';
  return input.configDaemon === true ? 'on' : 'off';
}

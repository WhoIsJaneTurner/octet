import { homedir } from 'node:os';
import { join } from 'node:path';
import { OctetError, realDoctorEnv, runDoctor, type Check } from '@octet/core';
import { completionScript } from './completion.ts';
import { installLauncher } from './install.ts';

export const formatCheck = (c: Check): string => `${c.level === 'ok' ? 'ok  ' : c.level === 'warn' ? 'WARN' : 'FAIL'} ${c.name}: ${c.message}`;

/** `doctor`, `install` and `completion`. `usage` is main.ts's USAGE, which completion is generated from. */
export function runToolCommand(group: string, cmd: string | undefined, usage: string): void {
  if (group === 'doctor') {
    // Wire the plan-hash check here once the plan vault exists: realDoctorEnv({ verifyPlans: ... }).
    const checks = runDoctor(realDoctorEnv());
    for (const c of checks) console.log(formatCheck(c));
    const bad = checks.filter((c) => c.level === 'fail').length;
    const warns = checks.filter((c) => c.level === 'warn').length;
    console.log(bad ? `\n${bad} problem${bad > 1 ? 's' : ''}, ${warns} warning${warns === 1 ? '' : 's'}` : `\nall good${warns ? `, ${warns} warning${warns > 1 ? 's' : ''}` : ''}`);
    process.exitCode = bad ? 1 : 0;
    return;
  }
  if (group === 'install') {
    // OCTET_BIN_DIR exists so the installer can be tried without touching ~/.local/bin.
    const r = installLauncher(process.env.OCTET_BIN_DIR ?? join(homedir(), '.local', 'bin'), homedir(), process.env.PATH ?? '', process.env.SHELL ?? '');
    for (const l of r.lines) console.log(l);
    return;
  }
  if (group === 'completion') {
    if (cmd !== 'zsh' && cmd !== 'bash') throw new OctetError('usage: completion zsh|bash');
    process.stdout.write(completionScript(cmd, usage));
  }
}

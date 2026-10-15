import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface InstallResult {
  launcher: string;
  /** `exists` = already there and correct; `differs` = a different file is there, left alone. */
  status: 'created' | 'exists' | 'differs';
  onPath: boolean;
  /** What to tell the user, one line each. */
  lines: string[];
}

export const CLI_MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));

export const launcherText = (cliMain: string): string => `#!/bin/sh\nexec node ${JSON.stringify(cliMain)} "$@"\n`;

/**
 * Creates `<binDir>/octet` if it is missing and says how to put binDir on PATH. It never edits
 * shell rc files and never overwrites a launcher that is already there.
 */
export function installLauncher(binDir: string, home: string, pathEnv: string, shell = '', cliMain: string = CLI_MAIN): InstallResult {
  const launcher = join(binDir, 'octet');
  const want = launcherText(cliMain);
  const lines: string[] = [];
  let status: InstallResult['status'];
  if (existsSync(launcher)) {
    status = readFileSync(launcher, 'utf8') === want ? 'exists' : 'differs';
    lines.push(status === 'exists' ? `launcher already installed: ${launcher}`
      : `a different file is already at ${launcher}; left alone. Delete it and run this again to replace it.`);
  } else {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(launcher, want);
    chmodSync(launcher, 0o755);
    status = 'created';
    lines.push(`created ${launcher} -> ${cliMain}`);
  }
  const onPath = pathEnv.split(delimiter).some((d) => d.replace(/\/+$/, '') === binDir.replace(/\/+$/, ''));
  if (!onPath) {
    const shown = binDir.startsWith(home + '/') ? `$HOME${binDir.slice(home.length)}` : binDir;
    const rc = shell.endsWith('zsh') ? '~/.zshrc' : shell.endsWith('bash') ? '~/.bash_profile' : 'your shell startup file';
    lines.push(`${binDir} is not on your PATH. Add this line to ${rc} (Octet does not edit it for you):`,
      `  export PATH="${shown}:$PATH"`);
  }
  const sh = shell.endsWith('bash') ? 'bash' : 'zsh';
  lines.push(`Tab completion: add  eval "$(octet completion ${sh})"  to the same file.`);
  return { launcher, status, onPath, lines };
}

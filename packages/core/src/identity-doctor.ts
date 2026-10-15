import { execFile } from 'node:child_process';
import { ghToken, sshProbeArgs, type Identity } from './identity.ts';

export interface IdentityHealth {
  id: string;
  ghUser: string;
  /** The account GitHub says the SSH key belongs to, or null when the key was not accepted. */
  sshUser: string | null;
  sshOk: boolean;
  tokenOk: boolean;
  ok: boolean;
}

/** Same probe as `sshWhoAmI`, without blocking the daemon while ssh waits on the network. */
function sshWho(id: Identity): Promise<string | null> {
  return new Promise((resolve) => {
    // GitHub exits 1 even on success; the greeting is on stderr.
    execFile('ssh', sshProbeArgs(id), { encoding: 'utf8', timeout: 20_000 }, (_err, _out, stderr) => {
      resolve(String(stderr).match(/^Hi ([^!]+)!/m)?.[1] ?? null);
    });
  });
}

/**
 * `octet identity doctor`: does each identity's SSH key reach the account it claims, and does `gh` hold a login for it.
 * Talks to GitHub, so callers run it on demand, never on a timer.
 */
export async function doctorIdentities(ids: Identity[]): Promise<IdentityHealth[]> {
  return Promise.all(ids.map(async (i) => {
    const sshUser = await sshWho(i);
    const sshOk = sshUser?.toLowerCase() === i.ghUser.toLowerCase();
    let tokenOk = true;
    try { ghToken(i); } catch { tokenOk = false; }
    return { id: i.id, ghUser: i.ghUser, sshUser, sshOk, tokenOk, ok: sshOk && tokenOk };
  }));
}

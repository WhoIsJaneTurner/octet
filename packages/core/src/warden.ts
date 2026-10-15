import { checkRemote, type Identity } from './identity.ts';
import { SEAT_BY_ID, type SeatId } from './seats.ts';

export type ActionKind = 'fs.write' | 'git.commit' | 'git.merge' | 'git.push' | 'pr.create' | 'pr.comment';

export interface Action {
  seat: SeatId;
  kind: ActionKind;
  identity?: Identity;
  remoteUrl?: string;
  /** Set once the user has approved this specific outbound action. */
  approved?: boolean;
}

export interface Decision {
  decision: 'allow' | 'deny' | 'ask';
  reason: string;
}

const allow = (reason: string): Decision => ({ decision: 'allow', reason });
const deny = (reason: string): Decision => ({ decision: 'deny', reason });

/** Deterministic policy. No model is consulted, so it cannot be talked out of a decision. */
export function evaluate(a: Action): Decision {
  const seat = SEAT_BY_ID[a.seat];
  switch (a.kind) {
    case 'fs.write':
    case 'git.commit':
      return seat.writesCode ? allow('seat builds code') : deny(`${seat.title} does not write code`);
    case 'git.merge':
      return a.seat === 'marshal' ? allow('marshal merges into the goal branch')
        : deny(`${seat.title} may not merge`);
    case 'git.push':
    case 'pr.create':
    case 'pr.comment': {
      if (a.seat !== 'courier') return deny(`${seat.title} may not leave the machine; only the Courier delivers`);
      if (!a.identity || !a.remoteUrl) return deny('identity and remote are required');
      const check = checkRemote(a.identity, a.remoteUrl);
      if (!check.ok) return deny(check.reason);
      return a.approved ? allow('approved by user') : { decision: 'ask', reason: 'outbound action needs your approval' };
    }
  }
}

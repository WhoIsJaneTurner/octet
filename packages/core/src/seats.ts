export const SEAT_IDS = [
  'chair', 'marshal', 'architect', 'scout', 'engineer', 'reviewer', 'warden', 'courier',
] as const;
export type SeatId = (typeof SEAT_IDS)[number];

export interface Seat {
  id: SeatId;
  title: string;
  job: string;
  kind: 'llm' | 'deterministic';
  writesCode: boolean;
}

export const SEATS: readonly Seat[] = [
  { id: 'chair', title: 'Chair', kind: 'llm', writesCode: false,
    job: 'Talks to the user, takes requests across projects, turns them into goals.' },
  { id: 'marshal', title: 'Marshal', kind: 'llm', writesCode: false,
    job: 'Runs one goal end to end: beads, dispatch, review loop, merges.' },
  { id: 'architect', title: 'Architect', kind: 'llm', writesCode: false,
    job: 'Writes the plan or spec for a goal.' },
  { id: 'scout', title: 'Scout', kind: 'llm', writesCode: false,
    job: 'Explores the codebase and reports findings before planning.' },
  { id: 'engineer', title: 'Engineer', kind: 'llm', writesCode: true,
    job: 'Builds one bead in its own worktree.' },
  { id: 'reviewer', title: 'Reviewer', kind: 'llm', writesCode: false,
    job: 'Approves or sends back each bead before it merges into the goal branch.' },
  { id: 'warden', title: 'Warden', kind: 'deterministic', writesCode: false,
    job: 'Checks every action against policy, queues risky ones for approval, keeps the audit log.' },
  { id: 'courier', title: 'Courier', kind: 'llm', writesCode: false,
    job: 'Pushes the branch, opens the PR, updates tickets, watches CI.' },
];

export const SEAT_BY_ID = Object.fromEntries(SEATS.map((s) => [s.id, s])) as Record<SeatId, Seat>;

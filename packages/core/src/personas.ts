import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SeatId } from './seats.ts';

const dir = fileURLToPath(new URL('../../../personas/', import.meta.url));

export function loadPersona(seat: SeatId): string {
  return readFileSync(`${dir}${seat}.md`, 'utf8');
}

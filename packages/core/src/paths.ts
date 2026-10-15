import { homedir } from 'node:os';
import { join } from 'node:path';

export const octetHome = (): string => process.env.OCTET_HOME ?? join(homedir(), '.config', 'octet');
export const dataHome = (): string =>
  process.env.OCTET_DATA ?? join(homedir(), '.local', 'share', 'octet');

export const identitiesFile = (): string => join(octetHome(), 'identities.toml');
export const projectsFile = (): string => join(octetHome(), 'projects.toml');
export const dbFile = (): string => join(dataHome(), 'octet.db');
export const runsDir = (): string => join(dataHome(), 'runs');

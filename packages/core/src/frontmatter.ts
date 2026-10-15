/**
 * A tiny YAML subset for vault files: flat `key: value` lines, where a value is a string, number, boolean,
 * null or an inline list of strings (`[a, b]`). Strings that need it are JSON-quoted. Not general YAML on
 * purpose: Octet only reads what it wrote, and humans may edit simple values.
 */
export type FmValue = string | number | boolean | null | string[];
export type Frontmatter = Record<string, FmValue>;

const needsQuote = (s: string): boolean =>
  s === '' || /^[\s]|[\s]$|^[-?:,[\]{}#&*!|>'"%@`]|: | #|^(true|false|null|-?\d+(\.\d+)?)$/.test(s) || /[\n\r]/.test(s);

const fmt = (v: FmValue): string => {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => (needsQuote(x) || x.includes(',') ? JSON.stringify(x) : x)).join(', ')}]`;
  return needsQuote(v) ? JSON.stringify(v) : v;
};

function splitList(inner: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (q) {
      cur += c;
      if (c === '\\') cur += inner[++i] ?? '';
      else if (c === '"') q = false;
    } else if (c === '"') { q = true; cur += c; }
    else if (c === ',') { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim() || out.length) out.push(cur.trim());
  return out.filter((x) => x !== '');
}

const scalar = (raw: string): string => (raw.startsWith('"') ? (JSON.parse(raw) as string) : raw);

function parseValue(raw: string): FmValue {
  const v = raw.trim();
  if (v === 'null' || v === '') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) return splitList(v.slice(1, -1)).map(scalar);
  return scalar(v);
}

export function stringifyFrontmatter(fm: Frontmatter): string {
  return `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${fmt(v)}`).join('\n')}\n---\n`;
}

export function parseFrontmatter(text: string): { data: Frontmatter; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text };
  const data: Frontmatter = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 1 || line.startsWith('#')) continue;
    data[line.slice(0, i).trim()] = parseValue(line.slice(i + 1));
  }
  return { data, body: text.slice(m[0].length) };
}

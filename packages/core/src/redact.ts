/** Patterns for common secret formats. Conservative on purpose: a miss is worse than a false hit. */
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED private key]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED github token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED github token]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED api key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED aws key id]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED slack token]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED jwt]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{20,}/g, '$1 [REDACTED]'],
  [/\b((?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*)(["']?)[^\s"']{8,}\2/gi, '$1[REDACTED]'],
];

export interface Redacted { text: string; count: number }

/** Replaces anything that looks like a credential. Returns how many were hit so the caller can warn. */
export function redact(text: string): Redacted {
  let count = 0;
  let out = text;
  for (const [re, sub] of PATTERNS) {
    out = out.replace(re, (...args) => {
      count++;
      return sub.replace(/\$(\d)/g, (_, n: string) => (args[Number(n)] as string | undefined) ?? '');
    });
  }
  return { text: out, count };
}

/** Redacts every string inside a JSON-like value. */
export function redactDeep<T>(value: T): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') { const r = redact(v); count += r.count; return r.text; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value) as T, count };
}

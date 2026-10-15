import { OctetError } from '@octet/core';

/**
 * Shell completion, generated from the USAGE text in main.ts so the two cannot drift: every
 * command line in USAGE is `  word word|alt <arg> [--flag]   description`, and the words before
 * the first `<arg>`, `[opt]` or `--flag` are the command path.
 */

export interface CommandTree {
  /** Top-level word -> second words (empty when the command takes none). */
  words: Map<string, Set<string>>;
  /** `group` or `group sub` -> flags that appear on its usage lines. */
  flags: Map<string, Set<string>>;
}

export function parseUsage(usage: string): CommandTree {
  const tree: CommandTree = { words: new Map(), flags: new Map() };
  for (const line of usage.split('\n')) {
    if (!/^ {2}[a-z]/.test(line)) continue;
    const spec = line.trim().split(/ {2,}/)[0]!; // the description follows two or more spaces
    const path: string[][] = [];
    for (const tok of spec.split(/\s+/)) {
      if (/^[<[-]/.test(tok)) break;
      path.push(tok.split('|'));
    }
    const [first, second] = path;
    if (!first) continue;
    const flags = spec.match(/--[a-z][a-z-]*/g) ?? [];
    for (const g of first) {
      const subs = tree.words.get(g) ?? new Set<string>();
      tree.words.set(g, subs);
      for (const s of second ?? []) subs.add(s);
      for (const key of [g, ...(second ?? []).map((s) => `${g} ${s}`)]) {
        const set = tree.flags.get(key) ?? new Set<string>();
        for (const f of flags) set.add(f);
        tree.flags.set(key, set);
      }
    }
  }
  return tree;
}

const list = (xs: Iterable<string>): string => [...xs].sort().join(' ');

/** One entry per top-level command: its second words and the flags used anywhere under it. */
function groups(t: CommandTree): { name: string; subs: string; flags: string }[] {
  return [...t.words].map(([name, subs]) => {
    const flags = new Set<string>(['--help']);
    for (const [k, f] of t.flags) if (k === name || k.startsWith(`${name} `)) for (const x of f) flags.add(x);
    return { name, subs: list(subs), flags: list(flags) };
  });
}

export function completionScript(shell: string, usage: string): string {
  const g = groups(parseUsage(usage));
  const top = [...g.map((x) => x.name), '--help'].sort().join(' ');
  const cases = (fmt: (x: (typeof g)[number]) => string) => g.map(fmt).join('\n');
  if (shell === 'bash') {
    return `# bash completion for octet. Load with: eval "$(octet completion bash)"
_octet() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" subs='' flags='--help'
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W '${top}' -- "$cur"))
    return
  fi
  case "\${COMP_WORDS[1]}" in
${cases((x) => `    ${x.name}) subs='${x.subs}'; flags='${x.flags}' ;;`)}
  esac
  if [ "$COMP_CWORD" -eq 2 ] && [[ "$cur" != -* ]]; then
    COMPREPLY=($(compgen -W "$subs" -- "$cur"))
  elif [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "$flags" -- "$cur"))
  fi
}
complete -F _octet octet
`;
  }
  if (shell === 'zsh') {
    return `#compdef octet
# zsh completion for octet. Load with: eval "$(octet completion zsh)"   (after compinit)
_octet() {
  local -a subs flags
  flags=(--help)
  if (( CURRENT == 2 )); then
    compadd -- ${top}
    return
  fi
  case "\$words[2]" in
${cases((x) => `    ${x.name}) subs=(${x.subs}); flags=(${x.flags}) ;;`)}
  esac
  if [[ "\$words[CURRENT]" == -* ]]; then
    compadd -- \$flags
  elif (( CURRENT == 3 )); then
    compadd -- \$subs
  fi
}
if [ "\$funcstack[1]" = "_octet" ]; then _octet "\$@"; else compdef _octet octet; fi
`;
  }
  throw new OctetError(`unknown shell "${shell}". Use: octet completion zsh|bash`);
}

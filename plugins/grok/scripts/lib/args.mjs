// Minimal arg helpers (inspired by codex patterns, kept tiny)
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      rest.push(a);
    }
  }
  return { flags, rest, raw: argv.join(' ') };
}

export function hasFlag(args, name) {
  return args.includes(`--${name}`) || args.includes(`-${name[0]}`);
}

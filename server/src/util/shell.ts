export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function joinShell(args: string[]): string {
  return args.map(shq).join(' ');
}


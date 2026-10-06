import { X509Certificate } from 'node:crypto';
import type { NginxListen, NginxSite, NginxTarget } from '../types.js';

/**
 * Pure parser of `nginx -T` output (plan decision 1: the data source is the
 * expanded dump only; the `# configuration file <path>:` markers attribute
 * each server block to its file). No I/O — for unit tests (the
 * cron.ts/ports.ts pattern).
 *
 * The parser is conservative (decision 8): an unclear field is skipped/empty,
 * not an error; `map`/`upstream`/`geo`/`if`/`stream` are silently ignored.
 */

export interface ParsedLocation {
  /** The first location argument (the match: '/', '~ ^/api/' etc.). */
  match: string;
  /** proxy_pass at the top level of the location; null — none. */
  proxyPass: string | null;
}

export interface ParsedServerBlock {
  /** File from the dump marker; null — no marker (should not happen). */
  file: string | null;
  serverNames: string[];
  listens: NginxListen[];
  /** The last root at the server block level; null — none. */
  root: string | null;
  /** The last ssl_certificate at the server block level; null — none. */
  sslCertificate: string | null;
  /** Only top-level locations (direct children of server). */
  locations: ParsedLocation[];
}

export interface ParsedNginxConfig {
  /**
   * ssl_certificate from the http level (a shared certificate, decision 7) —
   * the default for server blocks without their own. null — no certificate
   * at the http level.
   */
  httpSslCertificate: string | null;
  /** Top-level server blocks inside http. */
  sites: ParsedServerBlock[];
}

const FILE_MARKER_RE = /^# configuration file (.+?):?$/;

/** The `# configuration file <path>:` marker — the name of the next file. */
export function frameFile(line: string): string | null {
  const m = line.match(FILE_MARKER_RE);
  return m ? m[1] : null;
}

/** Split the dump into frames by file markers (the `/etc/cron.d` batch pattern). */
export function splitDumpFrames(text: string): Array<{ file: string; text: string }> {
  const frames: Array<{ file: string; text: string }> = [];
  let current: { file: string; lines: string[] } | null = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const file = frameFile(line);
    if (file !== null) {
      if (current) frames.push({ file: current.file, text: current.lines.join('\n') });
      current = { file, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) frames.push({ file: current.file, text: current.lines.join('\n') });
  return frames;
}

interface NginxStatement {
  directive: string;
  args: string[];
  /** Present — a block directive (server, location, http, upstream, ...). */
  block?: NginxStatement[];
}

/**
 * Tokenization of a frame's text: words, single/double quotes (values with
 * spaces and `#` inside quotes), `;` `{` `}` as separate tokens. `#`
 * comments are only outside quotes, up to the end of the line: a value like
 * `"a#b"` or `'it''s #1'` is not cut off (file markers are already removed
 * by the frame split; inside frames `#` is a comment). Braces are counted
 * lexically (decision 8): a `}` inside a string/quotes is not counted —
 * quotes escape it.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let inComment = false;
  const push = () => {
    if (cur) {
      tokens.push(cur);
      cur = '';
    }
  };
  for (const ch of text) {
    if (inComment) {
      if (ch === '\n') inComment = false;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '#') {
      push();
      inComment = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ';' || ch === '{' || ch === '}') {
      push();
      tokens.push(ch);
    } else if (/\s/.test(ch)) {
      push();
    } else {
      cur += ch;
    }
  }
  push();
  return tokens;
}

/** Tokens → a statement tree (a stack of blocks, lexical brace-matching). */
function parseStatements(tokens: string[]): NginxStatement[] {
  const root: NginxStatement[] = [];
  const stack: NginxStatement[][] = [root];
  let cur: { directive: string; args: string[] } | null = null;

  const pushStatement = (withBlock: boolean): void => {
    if (!cur) return;
    const st: NginxStatement = { directive: cur.directive, args: cur.args };
    if (withBlock) st.block = [];
    stack[stack.length - 1].push(st);
    if (withBlock && st.block) stack.push(st.block);
    cur = null;
  };

  for (const tok of tokens) {
    if (tok === ';') {
      pushStatement(false);
    } else if (tok === '{') {
      pushStatement(true);
    } else if (tok === '}') {
      pushStatement(false);
      if (stack.length > 1) stack.pop();
    } else if (cur) {
      cur.args.push(tok);
    } else {
      cur = { directive: tok, args: [] };
    }
  }
  return root;
}

/** The last value of a simple directive among direct children (in nginx "the last one wins"). */
function lastDirectiveValue(statements: NginxStatement[], directive: string): string | null {
  let value: string | null = null;
  for (const st of statements) {
    if (!st.block && st.directive === directive && st.args.length > 0) {
      value = st.args[st.args.length - 1];
    }
  }
  return value;
}

/**
 * Parse a single `listen` statement. Formats: `80`, `80 default_server`,
 * `443 ssl`, `127.0.0.1:8080`, `[::]:443 ssl`, `*:80`, `unix:/run/nginx.sock`.
 * An unrecognized format — addr as is, port null (the fact of listening is
 * not lost).
 */
export function parseListen(args: string[]): NginxListen | null {
  const first = args[0];
  if (!first) return null;
  const flags = args.slice(1);
  const ssl = flags.includes('ssl');
  const defaultServer = flags.includes('default_server');
  if (first.startsWith('unix:')) {
    return { addr: first, port: null, ssl: false, defaultServer };
  }
  if (/^\d+$/.test(first)) {
    return { addr: '', port: Number(first), ssl, defaultServer };
  }
  const m = first.match(/^(.*):(\d+)$/);
  if (m) {
    const addr = m[1] === '*' ? '' : m[1];
    return { addr, port: Number(m[2]), ssl, defaultServer };
  }
  return { addr: first, port: null, ssl, defaultServer };
}

function parseServerBlock(st: NginxStatement, file: string | null): ParsedServerBlock {
  const body = st.block ?? [];
  const serverNames: string[] = [];
  const listens: NginxListen[] = [];
  let root: string | null = null;
  let sslCertificate: string | null = null;
  const locations: ParsedLocation[] = [];

  for (const s of body) {
    if (!s.block) {
      switch (s.directive) {
        case 'server_name':
          serverNames.push(...s.args);
          break;
        case 'listen': {
          const l = parseListen(s.args);
          if (l) listens.push(l);
          break;
        }
        case 'root':
          if (s.args.length > 0) root = s.args[s.args.length - 1];
          break;
        case 'ssl_certificate':
          if (s.args.length > 0) sslCertificate = s.args[s.args.length - 1];
          break;
      }
    } else if (s.directive === 'location' && s.block) {
      // Only the top nesting level: nested locations are inside s.block and
      // do not get here (nor do if/limit_except etc. — not counted).
      // match is the full modifier+pattern: '/', '= /', '~ ^/api/'.
      locations.push({
        match: s.args.join(' '),
        proxyPass: lastDirectiveValue(s.block, 'proxy_pass'),
      });
    }
  }
  return { file, serverNames, listens, root, sslCertificate, locations };
}

/**
 * Parse `nginx -T` output. Each frame (file) is parsed separately: the http
 * level is needed only for the ssl_certificate default (it may live in
 * nginx.conf/conf.d while server blocks live in sites-enabled); server
 * blocks are collected across all frames.
 *
 * A frame with `http {}` — its direct children. A frame without the http
 * wrapper is http-context content from an include (conf.d/*,
 * sites-enabled/*): top-level directives count as http level, top-level
 * `server {}` — sites. A known v1 limitation: `stream` files from
 * stream-enabled also look like http-context content — their server blocks
 * get into sites (rare, and the columns will be empty, not wrong).
 */
export function parseNginxDump(text: string): ParsedNginxConfig {
  let httpSslCertificate: string | null = null;
  const sites: ParsedServerBlock[] = [];

  for (const frame of splitDumpFrames(text)) {
    const statements = parseStatements(tokenize(frame.text));
    const http = statements.find((s) => s.directive === 'http' && s.block);
    if (http?.block) {
      const ssl = lastDirectiveValue(http.block, 'ssl_certificate');
      if (ssl) httpSslCertificate = ssl;
      for (const st of http.block) {
        if (st.directive === 'server' && st.block) {
          sites.push(parseServerBlock(st, frame.file));
        }
      }
      continue;
    }
    // A frame without an http block — http-context content from an include.
    const ssl = lastDirectiveValue(statements, 'ssl_certificate');
    if (ssl) httpSslCertificate = ssl;
    for (const st of statements) {
      if (st.directive === 'server' && st.block) {
        sites.push(parseServerBlock(st, frame.file));
      }
    }
  }
  return { httpSslCertificate, sites };
}

/** http-level defaults for toSiteEntry (currently — only the shared certificate). */
export interface HttpDefaults {
  sslCertificate: string | null;
}

/**
 * Mapping a server block to a table row (decision 7): proxy_pass from
 * `location /`, otherwise from the first location with proxy_pass; none —
 * static by root; nothing at all — unknown. cert is filled by the snapshot
 * collector (needs I/O). The return value is NginxSite plus the internal
 * `certPath` (the PEM path for batch reading); the collector extracts it and
 * does not expose it.
 */
export function toSiteEntry(
  block: ParsedServerBlock,
  httpDefaults: HttpDefaults,
): NginxSite & { certPath: string | null } {
  let target: NginxTarget;
  const withProxy = block.locations.filter((l) => l.proxyPass !== null);
  const rootLoc = block.locations.find((l) => l.match === '/' && l.proxyPass !== null);
  const proxy = rootLoc ?? withProxy[0];
  if (proxy?.proxyPass) {
    target = { kind: 'proxy', value: proxy.proxyPass };
  } else if (block.root) {
    target = { kind: 'static', value: block.root };
  } else {
    target = { kind: 'unknown', value: '' };
  }
  return {
    file: block.file ?? '',
    serverNames: block.serverNames,
    isDefault: block.listens.some((l) => l.defaultServer),
    listens: block.listens,
    target,
    locationsCount: block.locations.length,
    // The certificate path for the collector: its own or the shared one from the http level (decision 7).
    cert: null,
    certPath: block.sslCertificate ?? httpDefaults.sslCertificate,
  };
}

/** Validity info from a PEM. */
export interface CertInfo {
  notAfter: Date;
  /** Whole days until expiry (may be negative — expired). */
  daysLeft: number;
}

/**
 * Local PEM parsing via `crypto.X509Certificate` (Node 20, `validTo`).
 * Without a remote `openssl` (decision 5): alpine/distroless images may not
 * have it, and the certificate expiry must not depend on the image contents.
 * A broken PEM → null. `now` — time injection for tests.
 */
export function certInfoFromPem(pem: string, now = Date.now()): CertInfo | null {
  try {
    const cert = new X509Certificate(pem);
    const notAfter = new Date(cert.validTo);
    if (Number.isNaN(notAfter.getTime())) return null;
    const daysLeft = Math.floor((notAfter.getTime() - now) / 86_400_000);
    return { notAfter, daysLeft };
  } catch {
    return null;
  }
}

/**
 * Split the certificate batch-read output into frames by `=== <path>`
 * markers (the `/etc/cron.d` pattern). A file that failed to read yields no
 * section in stdout (the command builder guards with `[ -f ]`) — it is not
 * in the Map.
 */
export function parseCertBatch(output: string): Map<string, string> {
  const result = new Map<string, string>();
  let current: string | null = null;
  const lines: string[] = [];
  const flush = () => {
    if (current !== null) result.set(current, lines.join('\n').replace(/\n$/, ''));
    lines.length = 0;
  };
  for (const line of output.replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(/^=== (.+)$/);
    if (m) {
      flush();
      current = m[1];
    } else if (current !== null) {
      lines.push(line);
    }
  }
  flush();
  return result;
}

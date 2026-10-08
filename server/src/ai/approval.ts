import path from 'node:path';
import { isAutoRunnable } from './tools.js';
import { isSensitivePath } from './redact.js';

/**
 * Agent access levels (docs/agent-access-levels-plan.md, revision v2): a
 * per-dialogue choice of how often mutating tools pause for a confirmation.
 *
 * - `always` — every mutating tool waits for approve/reject.
 * - `needed` (the default for new dialogues and for all pre-v2 dialogues
 *   without the field — a deliberate, user-approved lowering of the v1
 *   `always` bar) — low-risk mutations run automatically; arbitrary shell
 *   (`exec`), attaching a server, destructive docker actions and writes to
 *   system or sensitive paths still go through approval.
 * - `never` (Full Access) — everything runs without confirmations; enabled
 *   only with an explicit risk acknowledgement in the same WS frame
 *   (`set_approval_mode`, gated in ai/agent.ts).
 *
 * The mode switches off only the pause on confirmation: secret redaction,
 * the exec_readonly allow-list, timeouts and output limits stay in place in
 * every mode.
 */
export type AgentApprovalMode = 'always' | 'needed' | 'never';

/**
 * docker_action actions safe enough to auto-run in the `needed` mode:
 * per the tool schema (ai/tools.ts) everything but the deleting `rm`/`rmi`.
 * `run` only creates a new container — existing data is not touched.
 */
const LOW_RISK_DOCKER_ACTIONS = new Set(['start', 'stop', 'restart', 'pull', 'run']);

/** Writes outside home/project directories go to approval in `needed`. */
const SYSTEM_PATH_PREFIXES = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/boot',
  '/root',
  '/var/lib',
  '/var/log',
];

function isSystemPath(path: string): boolean {
  return SYSTEM_PATH_PREFIXES.some((pre) => path === pre || path.startsWith(`${pre}/`));
}

/**
 * Whether this tool call must wait for the user's decision. The decision
 * point is exactly one — AgentSession.runLoop (ai/agent.ts); runTool never
 * checks approvals itself. An unknown tool fails closed: approval requested.
 * The mode is read from the session field on every call — a WS
 * set_approval_mode acts immediately, without reconnecting.
 */
export function needsApproval(mode: AgentApprovalMode, name: string, args: Record<string, unknown>): boolean {
  // Read-only without signs of reading secrets is auto in every mode.
  if (isAutoRunnable(name, args)) return false;
  // Full Access: only the pause is switched off.
  if (mode === 'never') return false;
  // Default: every mutating call goes through approve.
  if (mode === 'always') return true;
  // `needed`: only low-risk mutations run automatically.
  if (name === 'write_memory') return false;
  if (name === 'docker_action') return !LOW_RISK_DOCKER_ACTIONS.has(String(args.action));
  if (name === 'write_file') {
    const p = String(args.path ?? '');
    // The classification must see the same string the SFTP call will use.
    // `..` segments, double slashes and relative paths can resolve into a
    // system or sensitive location (prompt injection can feed the model such
    // a path) while looking harmless to the prefix check — anything that is
    // not an already-canonical absolute path goes to approval (fail-closed).
    if (!p.startsWith('/')) return true;
    if (path.posix.normalize(p) !== p) return true;
    return isSensitivePath(p) || isSystemPath(p);
  }
  // exec (arbitrary shell bypasses any path classification) and
  // connect_server — approve in `needed` too.
  return true;
}

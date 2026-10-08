/**
 * Keep the prompt cache of idle Claude Code zmx sessions warm.
 *
 * A cold cache makes the next message rewrite the whole context (2x input
 * price on the 1h TTL), while a bump only reads it (0.05x on Opus 5.5). The
 * keeper reads cache state from each session's transcript and, when a session
 * is idle and close to expiry, types a [keepalive] message into its zmx PTY so
 * the bump reuses the live session's exact cache prefix.
 *
 * It needs only Node and the `zmx` binary the sessions run under, plus the
 * Claude home and the zmx socket directory; it never runs Claude Code. The
 * `claude-cache-keeper` bin wraps {@link runCli}.
 */
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const CLAUDE_HOME = join(homedir(), '.claude');
const STATUSLINE_STATE_DIR = join(CLAUDE_HOME, 'statusline-state');
// Read on every watch pass, so settings change without a restart.
const SETTINGS_FILE = join(CLAUDE_HOME, 'cache-keeper.json');
export const KEEPALIVE_TEXT =
  '[keepalive] No action needed. Reply with "ok" only.';
// Sent instead when the next bump would fall past --max-idle; no bump follows
// it until the next real prompt.
export const KEEPALIVE_LAST_TEXT = `${KEEPALIVE_TEXT} This is the last bump.`;
// After a bump, give the transcript time to record it before judging again.
// Claude Code records a submitted prompt within seconds, so a bump that did
// not land is retried on the next pass.
const BUMP_COOLDOWN_S = 30;
// Watch mode logs a one-line summary of every session this often, so a quiet
// log still shows the keeper is alive.
const HEARTBEAT_EVERY_S = 900;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
// User entries that do not count as the operator being active.
const NOT_A_PROMPT =
  /^(\[keepalive\]|\[Request interrupted|<task-notification>)/;
/* eslint-disable no-control-regex -- these match terminal escape sequences in zmx history */
const VT_ESCAPE =
  /\x1b(?:\[[0-9;:?]*[\x40-\x7e]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|.?)/g;
// Splits zmx history into CSI sequences (parameters, final byte), other
// escape sequences, and text.
const VT_TOKEN =
  /\x1b\[([0-9;:?]*)([\x40-\x7e])|\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)?|.?)|[^\x1b]+/g;
/* eslint-enable no-control-regex */

type Settings = {
  minContext: number;
  maxIdleHours: number;
  leadMinutes: number;
  max5hPct: number;
  interval: number;
};

const DEFAULTS: Settings = {
  minContext: 150_000,
  maxIdleHours: 10,
  leadMinutes: 5,
  max5hPct: 80,
  interval: 60,
};

const SETTING_FLAGS: Record<keyof Settings, string> = {
  minContext: 'min-context',
  maxIdleHours: 'max-idle',
  leadMinutes: 'lead',
  max5hPct: 'max-5h-pct',
  interval: 'interval',
};

type Mode = 'report' | 'act';

type ZmxSession = {
  name: string;
  pid: number;
  created: number;
  startDir: string;
};

export type TranscriptState = {
  // Timestamp of the latest user entry: the trigger of the next request.
  trigger: number;
  // Conservative start of the last request; the cache lifetime counts from it.
  reqStart: number;
  ttl: number;
  context: number;
  idle: boolean;
  lastPrompt: number;
  // The last bump was sent and no real prompt came after it.
  lastBumpSent: boolean;
};

type Usage = {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number };
};

type TranscriptEntry = {
  type?: string;
  timestamp?: string;
  isMeta?: boolean;
  message?: { content?: unknown; stop_reason?: string; usage?: Usage };
};

type Evaluation = {
  decision: string;
  left: string;
  ttl: string;
  context: string;
  idle: string;
};

type Keeper = {
  settings: Settings;
  overrides: Partial<Settings>;
  onlySession: string | undefined;
  dryRun: boolean;
  lastBump: Map<string, number>;
  lastDecision: Map<string, string>;
  transcripts: TranscriptReader;
  summary: string[];
};

function log(message: string): void {
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  process.stderr.write(`[cache-keeper][${stamp}] ${message}\n`);
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

function usage(): string {
  return `Usage: claude-cache-keeper <status|once|watch> [options]

Commands:
  status               Print the cache state and decision for each Claude zmx session. Never bumps.
  once                 Run one pass and bump the sessions that are due.
  watch                Run a pass every --interval seconds until killed.

Options:
  --min-context N      Skip sessions whose context is below N tokens (default ${DEFAULTS.minContext}).
  --max-idle H         Stop bumping H hours after the last real prompt (default ${DEFAULTS.maxIdleHours}).
                       The last bump says so in its keepalive text.
  --lead M             Bump when M minutes or less are left on the cache (default ${DEFAULTS.leadMinutes}).
  --max-5h-pct P       Skip bumps while the 5h rate limit is at P% or more (default ${DEFAULTS.max5hPct}).
  --interval S         Seconds between passes in watch mode (default ${DEFAULTS.interval}).
  --session NAME       Only consider this zmx session.
  --dry-run            Log what would be bumped without sending anything.
  -h, --help           Show this help.

Settings come from the defaults, then ${SETTINGS_FILE}
(for example {"minContext": 80000}), then the flags. watch re-reads the file
every pass.

Only sessions on the 1h cache TTL are bumped; on the 5m TTL a bump every few
minutes costs more than the occasional cold rewrite.

A due session whose input box holds a draft or is hidden is retried every pass
until its cache goes cold. A prompt suggestion does not count as a draft.
`;
}

function parseSetting(
  key: keyof Settings,
  raw: unknown,
  label: string,
): number {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  const min = key === 'interval' ? 1 : 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new Error(`${label} must be a number >= ${min}`);
  }
  return value;
}

let lastSettingsError = '';

function readSettingsFile(): Partial<Settings> {
  let raw: string;
  try {
    raw = readFileSync(SETTINGS_FILE, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('expected a JSON object');
    }
    const settings: Partial<Settings> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in DEFAULTS)) {
        throw new Error(`unknown key "${key}"`);
      }
      settings[key as keyof Settings] = parseSetting(
        key as keyof Settings,
        value,
        key,
      );
    }
    lastSettingsError = '';
    return settings;
  } catch (error) {
    // Log a broken file once, not on every pass.
    const message = `${SETTINGS_FILE}: ${(error as Error).message}; ignoring it`;
    if (message !== lastSettingsError) {
      log(message);
      lastSettingsError = message;
    }
    return {};
  }
}

function describeSettings(settings: Settings): string {
  return (
    `lead ${settings.leadMinutes}m, min context ${settings.minContext}, ` +
    `max idle ${settings.maxIdleHours}h, max 5h ${settings.max5hPct}%`
  );
}

/** Reloads the settings file; returns true when the effective settings changed. */
function refreshSettings(keeper: Keeper): boolean {
  const next: Settings = {
    ...DEFAULTS,
    ...readSettingsFile(),
    ...keeper.overrides,
  };
  const changed = (Object.keys(next) as (keyof Settings)[]).some(
    (key) => next[key] !== keeper.settings[key],
  );
  keeper.settings = next;
  return changed;
}

function zmx(args: string[]): string {
  return execFileSync('zmx', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function listClaudeSessions(): ZmxSession[] {
  let output: string;
  try {
    output = zmx(['list']);
  } catch {
    return [];
  }
  const sessions: ZmxSession[] = [];
  for (const line of output.split('\n')) {
    const fields = new Map<string, string>();
    for (const field of line.split('\t')) {
      // The current session is marked with a leading arrow.
      const cleaned = field.replace(/^[^a-z]*/, '');
      const eq = cleaned.indexOf('=');
      if (eq > 0) {
        fields.set(cleaned.slice(0, eq), cleaned.slice(eq + 1));
      }
    }
    const name = fields.get('name');
    const pid = Number(fields.get('pid'));
    if (
      name &&
      Number.isInteger(pid) &&
      /^claude( |$)/.test(fields.get('cmd') ?? '')
    ) {
      sessions.push({
        name,
        pid,
        created: Number(fields.get('created') ?? 0),
        startDir: fields.get('start_dir') ?? '',
      });
    }
  }
  return sessions;
}

/**
 * Returns the Claude session id of a zmx session's Claude process, from the
 * ~/.claude/sessions/<pid>.json file Claude Code keeps per process. That
 * directory also holds stale files from earlier pods, so the file must belong
 * to this very process:
 * - When the pid is visible here (same PID namespace), its start time must
 *   match the file's procStart.
 * - From a sidecar in another PID namespace, the file must have the zmx
 *   session's directory and a start time after the zmx session was created.
 */
function sessionIdFor(session: ZmxSession): string | undefined {
  let file: {
    cwd?: string;
    startedAt?: number;
    procStart?: string;
    sessionId?: string;
  };
  try {
    file = JSON.parse(
      readFileSync(
        join(CLAUDE_HOME, 'sessions', `${session.pid}.json`),
        'utf8',
      ),
    ) as typeof file;
  } catch {
    return undefined;
  }
  let stat: string | undefined;
  try {
    if (
      readFileSync(`/proc/${session.pid}/cmdline`, 'utf8').includes('claude')
    ) {
      stat = readFileSync(`/proc/${session.pid}/stat`, 'utf8');
    }
  } catch {
    // Not visible from this PID namespace.
  }
  if (stat !== undefined) {
    // The fields after the command name start at stat field 3, so starttime
    // (field 22) is index 19.
    const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return file.procStart === startTime ? file.sessionId : undefined;
  }
  // zmx records the session before it spawns Claude; allow a little clock skew.
  const startedAfterSession =
    (file.startedAt ?? 0) >= (session.created - 5) * 1000;
  return file.cwd === session.startDir &&
    session.created > 0 &&
    startedAfterSession
    ? file.sessionId
    : undefined;
}

function transcriptForSession(sessionId: string): string | undefined {
  const projects = join(CLAUDE_HOME, 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const candidate = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function epoch(timestamp: string): number {
  return Math.floor(Date.parse(timestamp) / 1000);
}

function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const first = content[0] as { type?: string; text?: unknown } | undefined;
    if (first?.type === 'text' && typeof first.text === 'string') {
      return first.text;
    }
  }
  return undefined;
}

export function applyEntry(state: TranscriptState, line: string): void {
  let entry: TranscriptEntry;
  try {
    entry = JSON.parse(line) as TranscriptEntry;
  } catch {
    return;
  }
  if (entry.type === 'user' && entry.timestamp) {
    state.trigger = epoch(entry.timestamp);
    const text = textOf(entry.message?.content);
    // An interrupted turn leaves the session idle.
    state.idle = text?.startsWith('[Request interrupted') ?? false;
    if (!entry.isMeta && text !== undefined && !NOT_A_PROMPT.test(text)) {
      state.lastPrompt = state.trigger;
      state.lastBumpSent = false;
    } else if (text === KEEPALIVE_LAST_TEXT) {
      state.lastBumpSent = true;
    }
  } else if (
    entry.type === 'assistant' &&
    entry.timestamp &&
    entry.message?.usage
  ) {
    const usage = entry.message.usage;
    state.reqStart = state.trigger || epoch(entry.timestamp);
    state.context =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    state.idle = entry.message.stop_reason === 'end_turn';
    if ((usage.cache_creation_input_tokens ?? 0) > 0) {
      state.ttl =
        (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0 ? 3600 : 300;
    }
  }
}

type TranscriptCursor = {
  ino: number;
  offset: number;
  rest: string;
  decoder: StringDecoder;
  state: TranscriptState;
};

/**
 * Reads each transcript incrementally: a pass only parses the lines appended
 * since the last one. Claude Code only appends; a replaced or truncated file
 * is read again from the start.
 */
export class TranscriptReader {
  private readonly cursors = new Map<string, TranscriptCursor>();

  read(path: string): TranscriptState {
    const { ino, size } = statSync(path);
    let cursor = this.cursors.get(path);
    if (!cursor || cursor.ino !== ino || size < cursor.offset) {
      cursor = {
        ino,
        offset: 0,
        rest: '',
        decoder: new StringDecoder('utf8'),
        state: {
          trigger: 0,
          reqStart: 0,
          ttl: 0,
          context: 0,
          idle: false,
          lastPrompt: 0,
          lastBumpSent: false,
        },
      };
      this.cursors.set(path, cursor);
    }
    if (size > cursor.offset) {
      // Chunks keep the first read of a large transcript within the sidecar's memory limit.
      const buffer = Buffer.alloc(
        Math.min(READ_CHUNK_BYTES, size - cursor.offset),
      );
      const fd = openSync(path, 'r');
      try {
        while (cursor.offset < size) {
          const read = readSync(
            fd,
            buffer,
            0,
            Math.min(buffer.length, size - cursor.offset),
            cursor.offset,
          );
          if (read === 0) {
            break;
          }
          cursor.offset += read;
          const lines = (
            cursor.rest + cursor.decoder.write(buffer.subarray(0, read))
          ).split('\n');
          // Keep a half-written last line for the next chunk or pass.
          cursor.rest = lines.pop() ?? '';
          for (const line of lines) {
            applyEntry(cursor.state, line);
          }
        }
      } finally {
        closeSync(fd);
      }
    }
    return cursor.state;
  }

  /** Drops cursors of transcripts that no live session uses any more. */
  retain(paths: Set<string>): void {
    for (const path of this.cursors.keys()) {
      if (!paths.has(path)) {
        this.cursors.delete(path);
      }
    }
  }
}

function fiveHourPct(sessionId: string): number | undefined {
  try {
    const snapshot = JSON.parse(
      readFileSync(join(STATUSLINE_STATE_DIR, `${sessionId}.json`), 'utf8'),
    ) as {
      rate_limits?: { five_hour?: { used_percentage?: unknown } };
    } | null;
    const pct = snapshot?.rate_limits?.five_hour?.used_percentage;
    return typeof pct === 'number' ? Math.floor(pct) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the text typed in the Claude input box ('' when empty), or
 * undefined when the box is not visible. The prompt line is the last one
 * starting with "❯"; a draft would follow the marker.
 */
function inputBoxText(name: string): string | undefined {
  let history: string;
  try {
    history = zmx(['history', name, '--vt']);
  } catch {
    return undefined;
  }
  const lines = history.trimEnd().split('\n').slice(-40);
  const prompt = lines
    .filter((line) => line.replace(VT_ESCAPE, '').startsWith('❯'))
    .at(-1);
  return prompt === undefined ? undefined : typedText(prompt);
}

/**
 * Returns the text typed after the "❯" marker of a styled prompt line. An
 * empty box shows only the cursor (inverse video), or a prompt suggestion as
 * placeholder text: the cursor on its first character and the rest dim.
 * Claude Code never dims typed text.
 */
export function typedText(line: string): string {
  let dim = false;
  let inverse = false;
  let afterMarker = false;
  let dimText = false;
  // A visible character that is neither dim nor under the cursor.
  let plainText = false;
  let text = '';
  for (const [token, params, final] of line.matchAll(VT_TOKEN)) {
    if (final === 'm') {
      const codes = params ? params.split(';').map(Number) : [0];
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0) {
          dim = false;
          inverse = false;
        } else if (code === 2) {
          dim = true;
        } else if (code === 22) {
          dim = false;
        } else if (code === 7) {
          inverse = true;
        } else if (code === 27) {
          inverse = false;
        } else if (code === 38 || code === 48 || code === 58) {
          // Skip the colour arguments: 5;n or 2;r;g;b.
          i += codes[i + 1] === 5 ? 2 : 4;
        }
      }
    }
    if (token.startsWith('\x1b')) {
      continue;
    }
    for (const char of token) {
      // trim() also drops the no-break space Claude Code pads the marker with.
      const visible = char.trim() !== '';
      if (!afterMarker) {
        afterMarker = char === '❯';
      } else if (dim) {
        dimText ||= visible;
      } else {
        text += char;
        plainText ||= visible && !inverse;
      }
    }
  }
  // Without dim text, an inverse character is the cursor on a typed character.
  return plainText || !dimText ? text.trim() : '';
}

/** Submits `text`; `typed` means a keepalive already sits in the input box. */
async function bump(name: string, text: string, typed: boolean): Promise<void> {
  if (!typed) {
    zmx(['send', name, text]);
    // Separate writes so Claude Code does not read the Enter as part of a paste.
    await sleep(1000);
  }
  zmx(['send', name, '\r']);
}

function fmtDuration(seconds: number): string {
  if (seconds <= 0) {
    return 'cold';
  }
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
  }
  return `${Math.floor(seconds / 60)}m`;
}

async function evaluate(
  keeper: Keeper,
  mode: Mode,
  session: ZmxSession,
  used: Set<string>,
): Promise<Evaluation> {
  const result: Evaluation = {
    decision: '',
    left: '-',
    ttl: '-',
    context: '-',
    idle: '-',
  };
  const sessionId = sessionIdFor(session);
  if (!sessionId) {
    return {
      ...result,
      decision: `skip: no session file matches this Claude process (pid ${session.pid})`,
    };
  }
  const transcript = transcriptForSession(sessionId);
  if (!transcript) {
    return { ...result, decision: `skip: no transcript for ${sessionId}` };
  }
  used.add(transcript);
  const state = keeper.transcripts.read(transcript);
  if (!state.reqStart || !state.ttl) {
    return { ...result, decision: 'skip: no cached request yet' };
  }

  const { minContext, maxIdleHours, leadMinutes, max5hPct, interval } =
    keeper.settings;
  const now = nowS();
  const left = state.reqStart + state.ttl - now;
  result.left = fmtDuration(left);
  result.ttl = state.ttl === 3600 ? '1h' : '5m';
  result.context = `${Math.floor(state.context / 1000)}k`;
  result.idle = state.idle ? 'yes' : 'no';
  const sinceBump = now - (keeper.lastBump.get(session.name) ?? 0);
  const pct = fiveHourPct(sessionId);

  if (left <= 0) {
    result.decision =
      'skip: already cold, a bump would only pay the rewrite early';
  } else if (state.ttl !== 3600) {
    result.decision = 'skip: 5m TTL';
  } else if (state.context < minContext) {
    result.decision = `skip: context below ${Math.floor(minContext / 1000)}k`;
  } else if (state.lastPrompt > 0 && state.lastBumpSent) {
    result.decision = 'skip: last bump sent, no real prompt since';
  } else if (
    state.lastPrompt > 0 &&
    now - state.lastPrompt > maxIdleHours * 3600
  ) {
    result.decision = `skip: no real prompt for over ${maxIdleHours}h`;
  } else if (!state.idle) {
    result.decision = 'skip: turn in progress or waiting on a prompt';
  } else if (left > leadMinutes * 60) {
    result.decision = `wait: bump in ${fmtDuration(left - leadMinutes * 60)}`;
  } else if (sinceBump < BUMP_COOLDOWN_S) {
    result.decision = `wait: bumped ${Math.floor(sinceBump / 60)}m ago`;
  } else if (pct !== undefined && pct >= max5hPct) {
    result.decision = `skip: 5h limit at ${pct}%`;
  }
  if (result.decision) {
    return result;
  }

  // Due: a blocked bump is retried every pass until the cache goes cold.
  const box = inputBoxText(session.name);
  // A keepalive whose Enter got lost only needs the Enter.
  const stuck = box === KEEPALIVE_TEXT || box === KEEPALIVE_LAST_TEXT;
  // The last bump is the one after which the next would come too late: the
  // next one is due ttl - lead from now and may wait one more interval for a pass.
  const last =
    state.lastPrompt > 0 &&
    now + state.ttl - leadMinutes * 60 + interval >
      state.lastPrompt + maxIdleHours * 3600;
  const lastNote = last && !stuck ? ' (last bump)' : '';
  if (box === undefined) {
    result.decision = 'retry: input box not visible';
  } else if (box !== '' && !stuck) {
    result.decision = 'retry: input box holds a draft';
  } else if (mode !== 'act') {
    result.decision = `due: would ${stuck ? 'submit the keepalive left in the input box' : 'bump now'}${lastNote}`;
  } else if (keeper.dryRun) {
    result.decision = `due: dry run, not bumping${lastNote}`;
  } else {
    await bump(
      session.name,
      last ? KEEPALIVE_LAST_TEXT : KEEPALIVE_TEXT,
      stuck,
    );
    keeper.lastBump.set(session.name, now);
    result.decision = stuck
      ? 'bumped: submitted the keepalive left in the input box'
      : `bumped${lastNote}`;
  }
  return result;
}

function row(cells: string[]): string {
  const widths = [36, 6, 4, 8, 5];
  return (
    cells
      .map((cell, i) =>
        i < widths.length ? cell.padEnd(widths[i] ?? 0) : cell,
      )
      .join(' ') + '\n'
  );
}

async function runPass(keeper: Keeper, mode: Mode): Promise<void> {
  const sessions = listClaudeSessions().filter(
    (s) => !keeper.onlySession || s.name === keeper.onlySession,
  );
  const used = new Set<string>();
  const seen = new Set<string>();
  keeper.summary = [];
  if (mode === 'report') {
    process.stdout.write(
      row(['SESSION', 'LEFT', 'TTL', 'CONTEXT', 'IDLE', 'DECISION']),
    );
  }

  for (const session of sessions) {
    let evaluation: Evaluation;
    try {
      evaluation = await evaluate(keeper, mode, session, used);
    } catch (error) {
      evaluation = {
        decision: `error: ${(error as Error).message}`,
        left: '-',
        ttl: '-',
        context: '-',
        idle: '-',
      };
    }
    if (mode === 'report') {
      const { left, ttl, context, idle, decision } = evaluation;
      process.stdout.write(
        row([session.name, left, ttl, context, idle, decision]),
      );
      continue;
    }
    seen.add(session.name);
    keeper.summary.push(`${session.name}: ${evaluation.decision}`);
    // Digits stripped, so a countdown ticking down is not a change but "wait"
    // turning into "skip" or "bumped" is. Every bump and retry is logged.
    const key = evaluation.decision.replace(/\d/g, '');
    if (
      /^(bumped|retry)/.test(evaluation.decision) ||
      key !== keeper.lastDecision.get(session.name)
    ) {
      log(
        `${session.name}: ${evaluation.decision} (left ${evaluation.left}, context ${evaluation.context})`,
      );
    }
    keeper.lastDecision.set(session.name, key);
  }

  if (mode === 'report') {
    if (sessions.length === 0) {
      process.stdout.write(
        `No Claude zmx sessions found${keeper.onlySession ? ` named ${keeper.onlySession}` : ''}.\n`,
      );
    }
    process.stdout.write(`\nSettings: ${describeSettings(keeper.settings)}\n`);
    return;
  }
  for (const name of keeper.lastDecision.keys()) {
    if (!seen.has(name)) {
      log(`${name}: session gone`);
      keeper.lastDecision.delete(name);
      keeper.lastBump.delete(name);
    }
  }
  keeper.transcripts.retain(used);
}

function logHeartbeat(keeper: Keeper): void {
  if (keeper.summary.length === 0) {
    log('heartbeat: no Claude zmx sessions');
  } else {
    log(
      `heartbeat: ${keeper.summary.length} Claude session(s); ${keeper.summary.join('; ')}`,
    );
  }
}

async function watch(keeper: Keeper): Promise<never> {
  log(
    `watching Claude zmx sessions every ${keeper.settings.interval}s ` +
      `(${describeSettings(keeper.settings)})${keeper.dryRun ? ', dry run' : ''}`,
  );
  // The first pass logs every session's decision, so the first heartbeat can
  // wait a full period.
  let lastHeartbeat = nowS();
  for (;;) {
    if (refreshSettings(keeper)) {
      log(
        `settings changed: every ${keeper.settings.interval}s (${describeSettings(keeper.settings)})`,
      );
    }
    try {
      await runPass(keeper, 'act');
    } catch (error) {
      log(`pass failed: ${(error as Error).message}`);
    }
    if (nowS() - lastHeartbeat >= HEARTBEAT_EVERY_S) {
      logHeartbeat(keeper);
      lastHeartbeat = nowS();
    }
    await sleep(keeper.settings.interval * 1000);
  }
}

function parseCli(argv: string[]): {
  command: string | undefined;
  help: boolean;
  keeper: Keeper;
} {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'min-context': { type: 'string' },
      'max-idle': { type: 'string' },
      lead: { type: 'string' },
      'max-5h-pct': { type: 'string' },
      interval: { type: 'string' },
      session: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const flags = values as Record<string, string | boolean | undefined>;
  const overrides: Partial<Settings> = {};
  for (const [key, flag] of Object.entries(SETTING_FLAGS) as [
    keyof Settings,
    string,
  ][]) {
    if (flags[flag] !== undefined) {
      overrides[key] = parseSetting(key, flags[flag], `--${flag}`);
    }
  }
  if (positionals.length > 1) {
    throw new Error(`Unexpected arguments: ${positionals.slice(1).join(' ')}`);
  }
  const keeper: Keeper = {
    settings: { ...DEFAULTS },
    overrides,
    onlySession: values.session,
    dryRun: values['dry-run'] ?? false,
    lastBump: new Map(),
    lastDecision: new Map(),
    transcripts: new TranscriptReader(),
    summary: [],
  };
  refreshSettings(keeper);
  return { command: positionals[0], help: values.help ?? false, keeper };
}

/** Runs the keeper CLI with `argv` (without the node and script paths). */
export async function runCli(argv: string[]): Promise<void> {
  // `status | head` closes the pipe early; that is not an error.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      process.exit(0);
    }
    throw error;
  });
  let cli: ReturnType<typeof parseCli>;
  try {
    cli = parseCli(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${usage()}`);
    process.exit(1);
  }
  if (cli.help) {
    process.stdout.write(usage());
    return;
  }
  switch (cli.command) {
    case 'status':
      await runPass(cli.keeper, 'report');
      return;
    case 'once':
      await runPass(cli.keeper, 'act');
      return;
    case 'watch':
      await watch(cli.keeper);
      return;
    default:
      process.stderr.write(
        `${cli.command ? `Unknown command: ${cli.command}\n\n` : ''}${usage()}`,
      );
      process.exit(1);
  }
}

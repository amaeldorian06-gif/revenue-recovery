import { randomUUID } from 'node:crypto';

/**
 * Structured JSON logs. One line per event: timestamp, level, request_id,
 * workspace_id, route, duration_ms, code. The redactor guarantees the phase's
 * hard rule — never an email body, a token, an amount with a client name, or
 * a draft text — by allowlisting keys, not by blacklisting them.
 */
const ALLOWED_KEYS = new Set([
  'request_id', 'workspace_id', 'route', 'duration_ms', 'code', 'level',
  'msg', 'job', 'count', 'status', 'method', 'attempt', 'event', 'endpoint',
  'rows', 'dupes', 'errors', 'size', 'reason_code', 'invitation', 'plan',
]);

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  request_id?: string;
  workspace_id?: string | null;
  route?: string;
  duration_ms?: number;
  code?: string;
  msg?: string;
  [key: string]: unknown;
}

function redact(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED_KEYS.has(k)) continue; // not allowlisted = not logged, by design
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

export function log(level: Level, fields: LogFields): void {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, ...redact(fields) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function newRequestId(): string {
  return randomUUID();
}

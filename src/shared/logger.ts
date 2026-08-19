/* --------
 * Types
 * -------- */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

/* --------
 * Internal state
 * -------- */

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info:  20,
  warn:  30,
  error: 40,
};

/**
 * Values that must never show up in a log, registered by whoever reads them from the Keychain.
 * See `.claude/rules/security.md` §1.
 */
const secrets = new Set<string>();

function resolveMinLevel(): LogLevel {
  const raw = process.env['MAILBRIDGE_LOG_LEVEL'];

  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

const minLevel: LogLevel = resolveMinLevel();

/* --------
 * Redaction
 * -------- */

/**
 * Registers a value as secret. Call it on every credential right after reading it, before use.
 * Very short strings are not registered: redacting them would make the output unreadable.
 */
export function registerSecret(value: string): void {
  if (value.length >= 4) {
    secrets.add(value);
  }
}

/**
 * Replaces every known secret with a placeholder, at any depth.
 */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    let output = value;

    for (const secret of secrets) {
      if (output.includes(secret)) {
        output = output.split(secret).join('[redacted]');
      }
    }

    return output;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry));
  }

  if (value instanceof Error) {
    return redact(value.message);
  }

  if (value !== null && typeof value === 'object') {
    const output: LogFields = {};

    for (const [key, entry] of Object.entries(value)) {
      output[key] = redact(entry);
    }

    return output;
  }

  return value;
}

/* --------
 * Implementation
 * -------- */

/**
 * Always writes to **stderr**: stdout is the MCP transport, and a log line there corrupts the
 * protocol.
 */
function write(level: LogLevel, message: string, fields: LogFields | undefined): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) {
    return;
  }

  const entry: LogFields = {
    level,
    message: redact(message),
    time:    new Date().toISOString(),
  };

  if (fields !== undefined) {
    entry['fields'] = redact(fields);
  }

  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export const logger = {
  debug: (message: string, fields?: LogFields): void => write('debug', message, fields),
  info:  (message: string, fields?: LogFields): void => write('info', message, fields),
  warn:  (message: string, fields?: LogFields): void => write('warn', message, fields),
  error: (message: string, fields?: LogFields): void => write('error', message, fields),
};

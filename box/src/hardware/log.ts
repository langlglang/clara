// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/log.ts.
/**
 * Plain one-line logs for the hardware link (journald keeps stdout on the Pi). Never pass a pulse reading's
 * session context, audio or a credential here: fields whose names look secret are redacted as a backstop.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const SECRET_FIELD = /credential|token|secret|authorization|password|audio|wav/i;

export function formatFields(fields: LogFields | undefined): string {
  if (!fields) return "";
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` ${key}=${SECRET_FIELD.test(key) ? "[redacted]" : JSON.stringify(value)}`)
    .join("");
}

export function createLogger(scope = "hardware", write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  const at = (level: string) => (message: string, fields?: LogFields) =>
    write(`${new Date().toISOString()} ${level} [${scope}] ${message}${formatFields(fields)}`);
  return { info: at("info"), warn: at("warn"), error: at("error") };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

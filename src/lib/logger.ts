type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogMeta {
  productId?: number;
  platform?: string;
  batch?: number;
  duration?: number;
  [key: string]: unknown;
}

function emit(level: LogLevel, message: string, meta?: LogMeta) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, meta?: LogMeta) => emit('info', msg, meta),
  warn: (msg: string, meta?: LogMeta) => emit('warn', msg, meta),
  error: (msg: string, meta?: LogMeta) => emit('error', msg, meta),
  debug: (msg: string, meta?: LogMeta) => emit('debug', msg, meta),
};

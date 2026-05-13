type LogFn = (fn: string, ...args: unknown[]) => void;

export interface Logger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  debug: LogFn;
}

export function createLogger(file: string): Logger {
  const fmt = (level: string, fn: string, ...args: unknown[]) => {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${level}] [${file}#${fn}]`, ...args);
  };

  return {
    info: (fn, ...args) => fmt("INFO", fn, ...args),
    warn: (fn, ...args) => {
      const ts = new Date().toISOString();
      console.warn(`[${ts}] [WARN] [${file}#${fn}]`, ...args);
    },
    error: (fn, ...args) => {
      const ts = new Date().toISOString();
      console.error(`[${ts}] [ERROR] [${file}#${fn}]`, ...args);
    },
    debug: (fn, ...args) => {
      const ts = new Date().toISOString();
      console.debug(`[${ts}] [DEBUG] [${file}#${fn}]`, ...args);
    },
  };
}

type LogFn = (fn: string, ...args: unknown[]) => void;

export interface Logger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  debug: LogFn;
}

// UTC+8 (Asia/Shanghai) 时间戳，格式: 2026-05-14T10:12:40.606+08:00
const beijingTime = () => {
  const d = new Date(Date.now() + 8 * 3600_000);
  return d.toISOString().replace("Z", "+08:00");
};

export function createLogger(file: string): Logger {
  const fmt = (level: string, fn: string, ...args: unknown[]) => {
    console.log(`[${beijingTime()}] [${level}] [${file}#${fn}]`, ...args);
  };

  return {
    info: (fn, ...args) => fmt("INFO", fn, ...args),
    warn: (fn, ...args) => {
      console.warn(`[${beijingTime()}] [WARN] [${file}#${fn}]`, ...args);
    },
    error: (fn, ...args) => {
      console.error(`[${beijingTime()}] [ERROR] [${file}#${fn}]`, ...args);
    },
    debug: (fn, ...args) => {
      console.debug(`[${beijingTime()}] [DEBUG] [${file}#${fn}]`, ...args);
    },
  };
}

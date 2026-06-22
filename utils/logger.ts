/**
 * logger.ts — lightweight prefixed console logger
 *
 * Call sites (file + line number) are preserved in the console because
 * each method is a console method bound with the prefix — the engine
 * never enters logger.ts at log time.
 *
 * Usage:
 *   import { createLogger } from './logger';
 *   const log = createLogger('MyModule');
 *   log.info('Hello');       // → MyModule: Hello          (shows your file:line)
 *   log.warn('Careful');     // → MyModule: Careful
 *   log.error('Oops');       // → MyModule: Oops
 *   log.debug('Value:', 42); // → MyModule: Value: 42  (only if debug enabled)
 */

export interface LoggerConfig {
  /** Master on/off switch (default: true) */
  enabled?: boolean;
  /** Prepend ISO timestamp to every message (default: false) */
  timestamps?: boolean;
  /** Enable log.debug() output (default: false) */
  debug?: boolean;
  /** global log prefix for all instances */
  prefix?: string;
}

export interface Logger {
  /** General-purpose log (maps to console.log) */
  log(...args: unknown[]): void;
  /** Informational message (maps to console.info) */
  info(...args: unknown[]): void;
  /** Warning (maps to console.warn) */
  warn(...args: unknown[]): void;
  /** Error (maps to console.error) */
  error(...args: unknown[]): void;
  /** Debug — only prints when debug mode is on */
  debug(...args: unknown[]): void;
  /** Start a collapsible console group */
  group(label: string): void;
  /** End a console group */
  groupEnd(): void;
}

// Console methods that map 1-to-1 (excluding debug which needs a guard)
type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'group';

const CONSOLE_METHODS: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'group'];

const globalConfig: Required<LoggerConfig> = {
  enabled: true,
  timestamps: false,
  debug: false,
  prefix: "Autodarts Tools",
};

/**
 * Configure global logger behaviour.
 * Call this once at your app entry point.
 */
export function configureLogger(options: LoggerConfig): void {
  Object.assign(globalConfig, options);
}

/**
 * Create a logger scoped to a module.
 *
 * Each property access re-evaluates enabled/timestamps at call time,
 * then returns a console method bound with the current prefix — so the
 * browser/Node records the caller's file and line, not logger.ts.
 *
 * @param prefix      - Label shown in every message, e.g. 'AuthService'
 * @param localConfig - Optional per-module overrides (same keys as configureLogger)
 */
export function createLogger(prefix: string, localConfig: LoggerConfig = {}): Logger {

  function isEnabled(): boolean {
    return localConfig.enabled ?? globalConfig.enabled;
  }

  function buildPrefix(): string {
    const parts: string[] = [];
    if (localConfig.timestamps ?? globalConfig.timestamps)
      parts.push(`[${new Date().toISOString()}]`);
    if (globalConfig.prefix)
      parts.push(`${globalConfig.prefix}:`);
    parts.push(`${prefix}:`);
    return parts.join(' ');
  }

  // noop used when logger is disabled or debug is off
  const noop = (): void => {};

  return new Proxy({} as Logger, {
    get(_target, prop: string): (...args: unknown[]) => void {
      if (!isEnabled()) return noop;

      // debug has an extra guard on top of isEnabled
      if (prop === 'debug') {
        return (localConfig.debug ?? globalConfig.debug)
          ? console.debug.bind(console, buildPrefix())
          : noop;
      }

      // groupEnd takes no prefix
      if (prop === 'groupEnd') {
        return console.groupEnd.bind(console);
      }

      // all other known methods: bind with the live prefix
      if ((CONSOLE_METHODS as string[]).includes(prop)) {
        return console[prop as ConsoleMethod].bind(console, buildPrefix());
      }

      return noop;
    },
  });
}

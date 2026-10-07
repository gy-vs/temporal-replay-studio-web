import { AsyncLocalStorage } from 'node:async_hooks';
import { DeterminismViolationError } from '../shared/errors';

interface DeterminismScope {
  label: string;
}

const activeScope = new AsyncLocalStorage<DeterminismScope>();
let installed = false;

function userStackSource(): string | undefined {
  const stack = new Error().stack?.split('\n');
  if (!stack) return undefined;
  const frame = stack.find((line) => {
    if (!line.trim().startsWith('at ')) return false;
    if (line.includes('node:internal') || line.includes('src/server/determinism.ts')) return false;
    if (line.includes('src/server/runtime') || line.includes('src/server/liveRunner') || line.includes('src/server/replayRunner')) {
      return false;
    }
    return true;
  });
  return frame?.trim();
}

function violation(api: string): never {
  throw new DeterminismViolationError(
    `Workflow used nondeterministic ${api}; use the injected WorkflowContext API instead`,
    userStackSource()
  );
}

export function installDeterminismGuards(): void {
  if (installed) return;
  installed = true;

  const NativeDate = Date;
  const DateProxy = new Proxy(NativeDate, {
    construct(_target, args: unknown[]) {
      if (activeScope.getStore()) violation(`new Date(${args.length ? '...' : ''})`);
      return Reflect.construct(NativeDate, args);
    },
    apply(target, thisArg, args) {
      if (activeScope.getStore()) violation('Date()');
      return Reflect.apply(target, thisArg, args) as unknown;
    },
    get(target, property, receiver) {
      if (property === 'now' && activeScope.getStore()) {
        return function guardedNow(): never {
          violation('Date.now()');
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });

  globalThis.Date = DateProxy as DateConstructor;

  const nativeMath = Math;
  const MathProxy = new Proxy(nativeMath, {
    get(target, property, receiver) {
      if (property === 'random' && activeScope.getStore()) {
        return function guardedRandom(): never {
          violation('Math.random()');
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  globalThis.Math = MathProxy as Math;
}

export async function runInDeterminismScope<T>(
  label: string,
  fn: () => Promise<T> | T
): Promise<T> {
  return activeScope.run({ label }, fn);
}

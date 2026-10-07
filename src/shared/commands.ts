import type { Command, Json } from './types';

export function normalizeJson(value: Json | undefined): Json | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item) as Json);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, Json>>((acc, key) => {
        const normalized = normalizeJson((value as Record<string, Json>)[key]);
        if (normalized !== undefined) acc[key] = normalized;
        return acc;
      }, {});
  }
  return value;
}

/**
 * Version markers remain compatible if they identify the same change and the
 * replay version falls inside the code's supported window. The concrete value
 * intentionally differs when old histories take the pre-change branch.
 */
export function commandsEqual(expected: Command, actual: Command): boolean {
  if (expected.type !== actual.type) return false;

  if (expected.type === 'mark-version') {
    const a = expected.payload as Record<string, Json>;
    const b = actual.payload as Record<string, Json>;
    return (
      a.changeId === b.changeId &&
      Number(a.minSupported) <= Number(b.version) &&
      Number(b.version) <= Number(b.maxSupported)
    );
  }

  if (expected.type === 'observe-runtime') {
    const a = expected.payload as Record<string, Json>;
    const b = actual.payload as Record<string, Json>;
    return a.kind === b.kind && a.min === b.min && a.max === b.max;
  }

  return JSON.stringify(normalizeJson(expected.payload)) ===
    JSON.stringify(normalizeJson(actual.payload));
}

export function commandSummary(command: Command): string {
  const p = command.payload as Record<string, Json>;
  switch (command.type) {
    case 'activity':
      return `activity ${String(p.activityName)}(${p.activityId})`;
    case 'cancel-activity':
      return `cancel activity ${String(p.activityId)}`;
    case 'start-timer':
      return `timer ${String(p.timerId)} ${String(p.durationMs)}ms`;
    case 'cancel-timer':
      return `cancel timer ${String(p.timerId)}`;
    case 'register-compensation':
      return `register compensation ${String(p.name)}`;
    case 'mark-version':
      return `version ${String(p.changeId)}=${String(p.version)}`;
    case 'observe-runtime':
      return `observe ${String(p.kind)}`;
    case 'workflow-result':
      return 'workflow result';
    case 'compensation-failure':
      return 'compensation failure';
  }
}

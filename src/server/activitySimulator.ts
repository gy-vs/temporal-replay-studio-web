import type { ActivityBehaviorConfig, Json } from '../shared/types';

export interface SimulatedActivity {
  name: string;
  behavior?: ActivityBehaviorConfig['behavior'];
  delayMs?: number;
  failureMessage?: string;
  result?: Json;
}

export interface PlannedActivityOutcome {
  behavior: NonNullable<ActivityBehaviorConfig['behavior']>;
  delayMs: number;
  failureMessage: string;
  result: Json;
  race: NonNullable<ActivityBehaviorConfig['race']>;
}

export class ActivitySimulator {
  private readonly definitions = new Map<string, SimulatedActivity>();

  constructor(definitions: SimulatedActivity[] = []) {
    definitions.forEach((definition) => this.definitions.set(definition.name, definition));
  }

  register(definition: SimulatedActivity): void {
    this.definitions.set(definition.name, definition);
  }

  plan(
    name: string,
    attempt: number,
    overrides: Record<string, ActivityBehaviorConfig> = {}
  ): PlannedActivityOutcome {
    const definition: Partial<SimulatedActivity> = this.definitions.get(name) ?? {};
    const override = overrides[name] ?? {};
    const behavior = override.behavior ?? definition.behavior ?? 'success';
    const result = override.result ?? definition.result ?? { ok: true, attempt };
    return {
      behavior,
      delayMs: override.delayMs ?? definition.delayMs ?? 100,
      failureMessage:
        override.failureMessage ?? definition.failureMessage ?? `simulated ${name} failure`,
      result,
      race: override.race ?? 'none',
    };
  }
}

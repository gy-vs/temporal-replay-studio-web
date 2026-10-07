import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkflowRegistry } from './runtime/registry.js';
import { workflowsDir } from './paths.js';

function source(file: string): string {
  return readFileSync(join(workflowsDir(), file), 'utf8');
}

export function createRegistry(): WorkflowRegistry {
  const registry = new WorkflowRegistry();
  registry.register('orderFulfillment', 'v1', source('orderFulfillment.v1.ts'), {
    fileName: 'orderFulfillment.v1.ts',
  });
  registry.register('orderFulfillment', 'v2', source('orderFulfillment.v2.ts'), {
    fileName: 'orderFulfillment.v2.ts',
  });
  registry.register('orderFulfillment', 'v3', source('orderFulfillment.v3.ts'), {
    fileName: 'orderFulfillment.v3.ts',
  });
  registry.register('nonDeterministic', 'v1', source('nonDeterministic.v1.ts'), {
    fileName: 'nonDeterministic.v1.ts',
  });
  registry.register('paymentRace', 'v1', source('paymentRace.v1.ts'), {
    fileName: 'paymentRace.v1.ts',
  });
  return registry;
}

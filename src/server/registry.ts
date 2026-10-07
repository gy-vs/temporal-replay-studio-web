import type { WorkflowDefinition, WorkflowDefinitionMeta } from '../shared/types';

export class WorkflowRegistry {
  private readonly definitions = new Map<string, WorkflowDefinition>();

  register(definition: WorkflowDefinition): void {
    const key = this.key(definition.workflowType, definition.version);
    this.definitions.set(key, definition);
  }

  get(workflowType: string, version: string): WorkflowDefinition | null {
    return this.definitions.get(this.key(workflowType, version)) ?? null;
  }

  list(): WorkflowDefinitionMeta[] {
    return [...this.definitions.values()].map(({ workflowType, version, description }) => ({
      workflowType,
      version,
      description,
    }));
  }

  versions(workflowType: string): WorkflowDefinitionMeta[] {
    return this.list().filter((definition) => definition.workflowType === workflowType);
  }

  private key(workflowType: string, version: string): string {
    return `${workflowType}@${version}`;
  }
}

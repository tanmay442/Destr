interface GuidanceSource {
  readonly name: string;
  readonly description: string;
  readonly guidance: {
    readonly useWhen: readonly string[];
    readonly doNotUseWhen: readonly string[];
    readonly resultSemantics: readonly string[];
  };
  readonly policy: {
    readonly effect: 'read' | 'write';
    readonly idempotent: boolean;
    readonly requiresApproval: boolean;
    readonly maxCallsPerTurn: number;
  };
}

export function buildCompactToolGuidance(definitions: readonly GuidanceSource[]): string {
  const blocks = definitions.map((definition) => {
    const useWhen = definition.guidance.useWhen.map((rule: string) => `- Use when: ${rule}`).join('\n');
    const doNot = definition.guidance.doNotUseWhen.map((rule: string) => `- Do not use when: ${rule}`).join('\n');
    const semantics = definition.guidance.resultSemantics.map((rule: string) => `- Result: ${rule}`).join('\n');
    const sections = [useWhen, doNot, semantics].filter((part) => part !== '').join('\n');
    return [
      `## ${definition.name}`,
      definition.description,
      sections,
      `Effect: ${definition.policy.effect}; idempotent: ${definition.policy.idempotent ? 'yes' : 'no'}; approval: ${definition.policy.requiresApproval ? 'required without explicit user request' : 'not required'}; max calls per turn: ${definition.policy.maxCallsPerTurn}.`,
    ].join('\n');
  });
  return ['# Tool Policy (generated from tool modules)', ...blocks].join('\n\n');
}

export function guidanceCoversTool(guidance: string, toolName: string): boolean {
  return guidance.includes(`## ${toolName}`);
}

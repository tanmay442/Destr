import type { ProviderToolCapabilities } from '@app/domain';
import type {
  ToolApprovalHookMode as DomainApprovalHookMode,
  ToolCallRepairMode as DomainCallRepairMode,
  ToolInputExampleMode as DomainInputExampleMode,
  ToolOutputSchemaMode as DomainOutputSchemaMode,
  ToolStrictSchemaMode as DomainStrictSchemaMode,
} from '@app/domain';

export type StrictSchemaMode = DomainStrictSchemaMode;
export type InputExampleMode = DomainInputExampleMode;
export type OutputSchemaMode = DomainOutputSchemaMode;
export type ToolCallRepairMode = DomainCallRepairMode;
export type ApprovalHookMode = DomainApprovalHookMode;
export type ModelToolCapabilities = ProviderToolCapabilities;

export const DEFAULT_TOOL_CAPABILITIES: ModelToolCapabilities = {
  strictSchemas: 'native',
  inputExamples: 'native',
  outputSchemas: 'validated_locally',
  parallelCalls: true,
  toolCallRepair: 'unsupported',
  approvalHooks: 'application',
};

export const EMULATED_EXAMPLE_CAPABILITIES: ModelToolCapabilities = {
  strictSchemas: 'native',
  inputExamples: 'description_middleware',
  outputSchemas: 'validated_locally',
  parallelCalls: true,
  toolCallRepair: 'unsupported',
  approvalHooks: 'application',
};

function formatExampleValue(value: unknown): string {
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  try {
    const text = JSON.stringify(value);
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
  } catch {
    return '[unserializable example]';
  }
}

export function examplesRequireEmulation(capabilities: ModelToolCapabilities): boolean {
  return capabilities.inputExamples !== 'native';
}

export function adaptDescriptionWithExamples(input: {
  description: string;
  examples: readonly unknown[];
  capabilities: ModelToolCapabilities;
  maxExamples?: number;
}): string {
  if (input.examples.length === 0) return input.description;
  if (input.capabilities.inputExamples === 'native') return input.description;
  if (input.capabilities.inputExamples === 'unsupported') return input.description;
  const count = Math.min(input.examples.length, input.maxExamples ?? 2);
  const lines = input.examples.slice(0, count).map((example, index) => `- Example ${index + 1}: ${formatExampleValue(example)}`);
  return `${input.description}\n\nInput examples:\n${lines.join('\n')}`;
}

export function describeCapabilities(capabilities: ModelToolCapabilities): string {
  return [
    `strict:${capabilities.strictSchemas}`,
    `examples:${capabilities.inputExamples}`,
    `output:${capabilities.outputSchemas}`,
    `parallel:${capabilities.parallelCalls ? 'yes' : 'no'}`,
    `repair:${capabilities.toolCallRepair}`,
    `approval:${capabilities.approvalHooks}`,
  ].join(' ');
}

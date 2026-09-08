export type ToolStrictSchemaMode = 'native' | 'emulated' | 'unsupported';
export type ToolInputExampleMode = 'native' | 'description_middleware' | 'unsupported';
export type ToolOutputSchemaMode = 'native' | 'validated_locally';
export type ToolCallRepairMode = 'supported' | 'unsupported';
export type ToolApprovalHookMode = 'native' | 'application';

export interface ProviderToolCapabilities {
  readonly strictSchemas: ToolStrictSchemaMode;
  readonly inputExamples: ToolInputExampleMode;
  readonly outputSchemas: ToolOutputSchemaMode;
  readonly parallelCalls: boolean;
  readonly toolCallRepair: ToolCallRepairMode;
  readonly approvalHooks: ToolApprovalHookMode;
}

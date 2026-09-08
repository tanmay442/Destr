import type { z } from 'zod';
import type {
  AgentToolContext,
  AgentToolDefinition,
  ToolExecuteCall,
  ToolGuidance,
  ToolPolicy,
} from './tool-contract';
import {
  adaptDescriptionWithExamples,
  type ModelToolCapabilities,
} from './model-tool-capabilities';
import { buildCompactToolGuidance } from './prompt/build-agent-instructions';
import {
  createPolicyCounts,
  sanitizeToolError,
  wrapToolWithPolicy,
  type PolicyCounts,
} from './tool-policy-pipeline';

export interface UntypedToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly outputSchema: z.ZodType<unknown>;
  readonly inputExamples: readonly unknown[];
  readonly guidance: ToolGuidance;
  readonly policy: ToolPolicy;
  readonly create: (context: AgentToolContext) => (input: unknown, call: ToolExecuteCall) => Promise<unknown>;
}

export type AnyToolDefinition = UntypedToolDefinition;

export function asUntypedTool<TInput, TOutput>(
  definition: AgentToolDefinition<TInput, TOutput>,
): UntypedToolDefinition {
  const innerCreate = definition.create.bind(definition);
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema as unknown as z.ZodType<unknown>,
    outputSchema: definition.outputSchema as unknown as z.ZodType<unknown>,
    inputExamples: definition.inputExamples as unknown as readonly unknown[],
    guidance: definition.guidance,
    policy: definition.policy,
    create: (context: AgentToolContext) => {
      const inner = innerCreate(context);
      return (input: unknown, call: ToolExecuteCall) => inner(input as TInput, call);
    },
  };
}

export const TOOL_CATALOG_VERSION = 'tool-catalog-v1';

export interface BuiltToolInstance {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly outputSchema: z.ZodType<unknown>;
  /** Native AI SDK examples are wrapped in the SDK's `{ input }` envelope. */
  readonly inputExamples: readonly { readonly input: unknown }[] | undefined;
  /** `undefined` means the provider does not support a strict-schema fact. */
  readonly strict: boolean | undefined;
  readonly execute: (rawInput: unknown, call: ToolExecuteCall) => Promise<unknown>;
  readonly policyEffect: 'read' | 'write';
}

export interface BuiltToolSet {
  readonly tools: ReadonlyMap<string, BuiltToolInstance>;
  readonly guidanceBlock: string;
  readonly catalogVersion: string;
  readonly capabilities: ModelToolCapabilities;
}

export interface CatalogBuildInput {
  readonly context: AgentToolContext;
  readonly capabilities: ModelToolCapabilities;
  readonly enabledTools: ReadonlySet<string>;
  readonly counts?: PolicyCounts | undefined;
}

export interface ToolCatalog {
  buildForRun(input: CatalogBuildInput): BuiltToolSet;
}

function assertUniqueNames(definitions: readonly UntypedToolDefinition[]): void {
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (definition.name.trim() === '') throw new Error('ToolCatalog: tool name must not be empty.');
    if (seen.has(definition.name)) throw new Error(`ToolCatalog: duplicate tool name "${definition.name}".`);
    seen.add(definition.name);
  }
}

export class DefaultToolCatalog implements ToolCatalog {
  private readonly definitions: readonly UntypedToolDefinition[];

  constructor(definitions: readonly UntypedToolDefinition[]) {
    assertUniqueNames(definitions);
    this.definitions = [...definitions];
  }

  get registeredNames(): readonly string[] {
    return this.definitions.map((definition) => definition.name);
  }

  buildForRun(input: CatalogBuildInput): BuiltToolSet {
    const counts = input.counts ?? createPolicyCounts();
    const tools = new Map<string, BuiltToolInstance>();
    for (const definition of this.definitions) {
      if (!input.enabledTools.has(definition.name)) continue;
      const inner = definition.create(input.context);
      const wrapped = wrapToolWithPolicy({
        definition,
        context: input.context,
        inner,
        counts,
      });
      const description = adaptDescriptionWithExamples({
        description: definition.description,
        examples: definition.inputExamples,
        capabilities: input.capabilities,
      });
      const inputExamples = input.capabilities.inputExamples === 'native'
        ? definition.inputExamples.map((example) => ({ input: example }))
        : undefined;
      const strict = input.capabilities.strictSchemas === 'unsupported'
        ? undefined
        : input.capabilities.strictSchemas === 'native';
      const execute = async (rawInput: unknown, call: ToolExecuteCall): Promise<unknown> => {
        try {
          return await wrapped(rawInput, call);
        } catch (error) {
          throw sanitizeToolError(error);
        }
      };
      tools.set(definition.name, {
        name: definition.name,
        description,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        inputExamples,
        strict,
        execute,
        policyEffect: definition.policy.effect,
      });
    }
    const enabledDefinitions = this.definitions.filter((definition) => input.enabledTools.has(definition.name));
    return {
      tools,
      guidanceBlock: buildCompactToolGuidance(enabledDefinitions),
      catalogVersion: TOOL_CATALOG_VERSION,
      capabilities: input.capabilities,
    };
  }
}

export function createToolCatalog(definitions: readonly UntypedToolDefinition[]): ToolCatalog {
  return new DefaultToolCatalog(definitions);
}

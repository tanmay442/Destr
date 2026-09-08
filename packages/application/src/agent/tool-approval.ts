import { createHash, randomUUID } from 'node:crypto';
import type {
  ApprovalCheckInput,
  ApprovalIssueInput,
  ToolApprovalPolicy,
} from './tool-contract';

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value.trim());
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(String(value));
}

export function normalizeToolArgs(args: unknown): string {
  const stable = stableJson(args);
  return createHash('sha256').update(stable, 'utf8').digest('hex');
}

const EXPLICIT_TICKET_PATTERNS: readonly RegExp[] = [
  /\bopen\s+(a\s+)?(knowledge\s+)?ticket\b/i,
  /\bfile\s+(a\s+)?(knowledge\s+)?ticket\b/i,
  /\bcreate\s+(a\s+)?(knowledge\s+)?ticket\b/i,
  /\braise\s+(a\s+)?(knowledge\s+)?ticket\b/i,
  /\bsubmit\s+(a\s+)?(complaint|ticket)\b/i,
  /\bescalate\b/i,
  /\btalk\s+to\s+(a\s+)?human\b/i,
  /\bhuman\s+support\b/i,
  /\bhuman\s+review\b/i,
];

const TICKET_ACTION = /(?:open\s+(?:a\s+)?(?:knowledge\s+)?ticket|file\s+(?:a\s+)?(?:knowledge\s+)?ticket|create\s+(?:a\s+)?(?:knowledge\s+)?ticket|raise\s+(?:a\s+)?(?:knowledge\s+)?ticket|submit\s+(?:a\s+)?(?:complaint|ticket)|escalate|talk\s+to\s+(?:a\s+)?human|speak\s+to\s+(?:a\s+)?human|human\s+support|human\s+review)\b/i;
const DIRECT_REQUEST = /(?:^|[.!?]\s+|,\s*)(?:(?:please|kindly)[,\s]+)?(?:open|file|create|raise|submit|escalate|talk\s+to|speak\s+to)\b/i;
const POLITE_REQUEST = /\b(?:can|could|would)\s+you\s+(?:please\s+)?(?:open|file|create|raise|submit|escalate|talk\s+to|speak\s+to)\b|\b(?:i\s+want|i\s+need|i(?:'|’)d\s+like)\s+(?:you\s+to\s+)?(?:open|file|create|raise|submit|escalate|talk\s+to|speak\s+to)\b/i;
const NEGATION_BEFORE_ACTION = /\b(?:do\s+not|don't|dont|never|no\s+need\s+to|not|without|avoid|stop|cancel|refuse|wouldn't|shouldn't|can't|cannot)\b[\s\S]{0,80}\b(?:open|file|create|raise|submit|escalate|talk\s+to|speak\s+to)\b/i;

function removeQuotedText(text: string): string {
  return text.replace(/(["`])(?:\\.|(?!\1)[^\\])*\1/g, ' ');
}

export function isExplicitTicketRequestText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  const withoutQuotedText = removeQuotedText(trimmed);
  if (withoutQuotedText === trimmed && /["`]/.test(trimmed)) return false;
  if (!EXPLICIT_TICKET_PATTERNS.some((pattern) => pattern.test(withoutQuotedText))) return false;
  if (NEGATION_BEFORE_ACTION.test(withoutQuotedText)) return false;
  return (DIRECT_REQUEST.test(withoutQuotedText) || POLITE_REQUEST.test(withoutQuotedText)) && TICKET_ACTION.test(withoutQuotedText);
}

export function isExplicitTicketRequestFromMessages(messages: readonly { role: string; text: string }[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.role !== 'user') continue;
    return isExplicitTicketRequestText(message.text);
  }
  return false;
}

interface StoredApproval {
  readonly key: string;
  readonly expiresAt: number;
}

function approvalKey(input: { toolName: string; normalizedArgs: string; userId: string; turnId: string }): string {
  return [input.toolName, input.normalizedArgs, input.userId, input.turnId].join('\0');
}

export class InMemoryToolApprovalPolicy implements ToolApprovalPolicy {
  private readonly tokens = new Map<string, StoredApproval>();
  private explicitNormalizedArgs: string | undefined;
  constructor(
    private readonly opts: {
      readonly explicitTicketRequest: boolean;
      readonly userId: string;
      readonly turnId: string;
      readonly explicitToolName?: string;
      readonly explicitNormalizedArgs?: string;
    },
  ) {
    this.explicitNormalizedArgs = opts.explicitNormalizedArgs;
  }

  isExplicitlyRequested(input: ApprovalCheckInput): boolean {
    if (!this.opts.explicitTicketRequest) return false;
    if (input.toolName !== (this.opts.explicitToolName ?? 'createKnowledgeTicket')) return false;
    if (input.userId !== this.opts.userId || input.turnId !== this.opts.turnId) return false;
    if (this.explicitNormalizedArgs === undefined) this.explicitNormalizedArgs = input.normalizedArgs;
    return this.explicitNormalizedArgs === input.normalizedArgs;
  }

  issueApproval(input: ApprovalIssueInput): { readonly token: string; readonly expiresAt: number } {
    const token = randomUUID();
    const ttlMs = Number.isFinite(input.ttlMs) ? Math.max(1, input.ttlMs) : 1;
    const expiresAt = input.nowMs + ttlMs;
    this.tokens.set(token, { key: approvalKey({
      toolName: input.toolName,
      normalizedArgs: input.normalizedArgs,
      userId: input.userId,
      turnId: input.turnId,
    }), expiresAt });
    return { token, expiresAt };
  }

  isApproved(input: ApprovalCheckInput): boolean {
    const token = input.approvalToken;
    if (token === undefined || token.trim() === '') return false;
    const wanted = approvalKey({
      toolName: input.toolName,
      normalizedArgs: input.normalizedArgs,
      userId: input.userId,
      turnId: input.turnId,
    });
    if (input.userId !== this.opts.userId) return false;
    if (input.turnId !== this.opts.turnId) return false;
    const stored = this.tokens.get(token);
    if (stored === undefined) return false;
    if (input.nowMs >= stored.expiresAt) {
      this.tokens.delete(token);
      return false;
    }
    return stored.key === wanted;
  }

  isApprovedWithToken(input: ApprovalCheckInput & { readonly token: string }): boolean {
    return this.isApproved({ ...input, approvalToken: input.token });
  }
}

export function createApprovalPolicyForTurn(input: {
  lastUserText: string;
  userId: string;
  turnId: string;
}): ToolApprovalPolicy {
  return new InMemoryToolApprovalPolicy({
    explicitTicketRequest: isExplicitTicketRequestText(input.lastUserText),
    userId: input.userId,
    turnId: input.turnId,
    explicitToolName: 'createKnowledgeTicket',
  });
}

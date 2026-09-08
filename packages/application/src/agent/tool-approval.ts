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

export function isExplicitTicketRequestText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  return EXPLICIT_TICKET_PATTERNS.some((pattern) => pattern.test(trimmed));
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
  constructor(
    private readonly opts: {
      readonly explicitTicketRequest: boolean;
      readonly userId: string;
      readonly turnId: string;
    },
  ) {}

  isExplicitlyRequested(): boolean {
    return this.opts.explicitTicketRequest;
  }

  issueApproval(input: ApprovalIssueInput): { readonly token: string; readonly expiresAt: number } {
    const expectedKey = approvalKey({
      toolName: input.toolName,
      normalizedArgs: input.normalizedArgs,
      userId: input.userId,
      turnId: input.turnId,
    });
    void expectedKey;
    const token = randomUUID();
    const expiresAt = input.nowMs + Math.max(1, input.ttlMs);
    const key = approvalKey({
      toolName: input.toolName,
      normalizedArgs: input.normalizedArgs,
      userId: this.opts.userId,
      turnId: this.opts.turnId,
    });
    void key;
    const storeKey = `${input.toolName}\0${input.normalizedArgs}\0${input.userId}\0${input.turnId}\0${token}`;
    this.tokens.set(storeKey, { key: approvalKey({
      toolName: input.toolName,
      normalizedArgs: input.normalizedArgs,
      userId: input.userId,
      turnId: input.turnId,
    }), expiresAt });
    return { token, expiresAt };
  }

  isApproved(input: ApprovalCheckInput): boolean {
    const wanted = approvalKey({
      toolName: input.toolName,
      normalizedArgs: input.normalizedArgs,
      userId: input.userId,
      turnId: input.turnId,
    });
    if (input.userId !== this.opts.userId) return false;
    if (input.turnId !== this.opts.turnId) return false;
    for (const [storeKey, stored] of this.tokens) {
      if (stored.key !== wanted) continue;
      if (input.nowMs > stored.expiresAt) {
        this.tokens.delete(storeKey);
        continue;
      }
      const parts = storeKey.split('\0');
      const tokenUser = parts[2];
      const tokenTurn = parts[3];
      if (tokenUser !== input.userId) continue;
      if (tokenTurn !== input.turnId) continue;
      return true;
    }
    return false;
  }

  isApprovedWithToken(input: ApprovalCheckInput & { readonly token: string }): boolean {
    const storeKey = `${input.toolName}\0${input.normalizedArgs}\0${input.userId}\0${input.turnId}\0${input.token}`;
    const stored = this.tokens.get(storeKey);
    if (!stored) return false;
    if (input.userId !== this.opts.userId) return false;
    if (input.turnId !== this.opts.turnId) return false;
    if (input.nowMs > stored.expiresAt) {
      this.tokens.delete(storeKey);
      return false;
    }
    return stored.key === approvalKey({
      toolName: input.toolName,
      normalizedArgs: input.normalizedArgs,
      userId: input.userId,
      turnId: input.turnId,
    });
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
  });
}

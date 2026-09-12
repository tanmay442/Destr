export const SAFE_RESPONSE_VERSION = 'v1' as const;

export const SAFE_NEXT_ACTIONS: readonly string[] = Object.freeze([
  'rephrase the question',
  'ask a narrower documentation question',
  'request a knowledge ticket',
]);

export interface SafeResponseInput {
  readonly decisionKind: 'rejected' | 'unverified';
  readonly reason: string;
  readonly ticketEligible: boolean;
}

export interface SafeResponse {
  readonly text: string;
  readonly offerTicket: boolean;
}

const REJECTED_BASE =
  "I couldn't verify this against our documentation, so I can't share an answer yet.";

const UNVERIFIED_BASE =
  "I couldn't complete source verification, so I can't share an answer yet.";

const RECOVERY_NO_TICKET = 'Try rephrasing the question or asking a narrower documentation question.';

const RECOVERY_WITH_TICKET =
  'Try rephrasing the question, asking a narrower documentation question, ' +
  'or requesting a knowledge ticket so someone can follow up.';

export function safeResponseFor(input: SafeResponseInput): SafeResponse {
  // The machine-readable reason is accepted for caller uniformity only and is
  // deliberately excluded from user-visible text: safe responses must never
  // leak internal errors, document content, candidate text, or provider payloads.
  void input.reason;
  const base = input.decisionKind === 'rejected' ? REJECTED_BASE : UNVERIFIED_BASE;
  const recovery = input.ticketEligible ? RECOVERY_WITH_TICKET : RECOVERY_NO_TICKET;
  const response: SafeResponse = {
    text: `${base} ${recovery}`,
    offerTicket: input.ticketEligible,
  };
  return Object.freeze(response);
}

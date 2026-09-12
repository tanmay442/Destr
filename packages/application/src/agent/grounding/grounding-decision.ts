import { z } from 'zod';

export const groundingCitationSchema = z.object({
  id: z.number().int().nonnegative(),
  chunkUid: z.string().trim().min(1).max(200).optional(),
  documentId: z.number().int().positive(),
  chunkIndex: z.number().int().nonnegative(),
  subquestionId: z.string().trim().min(1).max(100).optional(),
  snippet: z.string().min(1),
});

export type GroundingCitation = z.infer<typeof groundingCitationSchema>;

export const verifiedDecisionSchema = z.object({
  kind: z.literal('verified'),
  citations: z.array(groundingCitationSchema).min(1),
});

export const rejectedReasonSchema = z.enum(['unsupported_claim', 'missing_citation']);

export const rejectedDecisionSchema = z.object({
  kind: z.literal('rejected'),
  reason: rejectedReasonSchema,
});

export const unverifiedReasonSchema = z.enum(['timeout', 'grader_unavailable', 'malformed']);

export const unverifiedDecisionSchema = z.object({
  kind: z.literal('unverified'),
  reason: unverifiedReasonSchema,
});

export const groundingDecisionSchema = z.discriminatedUnion('kind', [
  verifiedDecisionSchema,
  rejectedDecisionSchema,
  unverifiedDecisionSchema,
]);

export type GroundingDecision = z.infer<typeof groundingDecisionSchema>;
export type VerifiedDecision = z.infer<typeof verifiedDecisionSchema>;
export type RejectedDecision = z.infer<typeof rejectedDecisionSchema>;
export type UnverifiedDecision = z.infer<typeof unverifiedDecisionSchema>;
export type RejectedReason = z.infer<typeof rejectedReasonSchema>;
export type UnverifiedReason = z.infer<typeof unverifiedReasonSchema>;

export interface StructuredEvidenceItem {
  readonly chunkUid?: string | undefined;
  readonly documentId: number;
  readonly chunkIndex: number;
  readonly subquestionIds: readonly string[];
  readonly callIds: readonly string[];
  readonly queryIds: readonly string[];
  readonly content: string;
  readonly source?: string | null | undefined;
}

export function evidenceStableKey(item: Pick<StructuredEvidenceItem, 'chunkUid' | 'documentId' | 'chunkIndex'>): string {
  const uid = item.chunkUid?.trim();
  if (uid) return `chunk_uid:${uid}`;
  return `document_chunk:${item.documentId}:${item.chunkIndex}`;
}

export function citationStableKey(
  citation: Pick<GroundingCitation, 'chunkUid' | 'documentId' | 'chunkIndex'>,
): string {
  const uid = citation.chunkUid?.trim();
  if (uid) return `chunk_uid:${uid}`;
  return `document_chunk:${citation.documentId}:${citation.chunkIndex}`;
}

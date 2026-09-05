/**
 * Fixed CI-only corpus for the mock evaluator.  These documents are synthetic
 * and intentionally include distractors so mock retrieval exercises ranking
 * over records rather than a query-to-document lookup table.
 */
export interface SyntheticMockCorpusRecord {
  readonly kind: 'relevant' | 'distractor';
  readonly documentId: number;
  readonly documentUid: string;
  readonly chunkUid: string;
  readonly content: string;
}

export const SYNTHETIC_MOCK_CORPUS_VERSION = 'synthetic-mock-corpus.v2';

export const syntheticMockCorpus = [
  {
    kind: 'relevant',
    documentId: 101,
    documentUid: 'doc-synth-password-guide',
    chunkUid: 'chunk-synth-password-procedure',
    content:
      'Synthetic password guide answer: to reset a password, open settings and choose reset; the reset completes in seven minutes. Password requirements use twelve characters. The password expire policy is ninety days. Change the password from settings. Too many password attempts trigger a temporary lockout.',
  },
  {
    kind: 'relevant',
    documentId: 102,
    documentUid: 'doc-synth-dental-guide',
    chunkUid: 'chunk-synth-dental-coverage',
    content:
      'Synthetic dental guide answer: the dental plan covers dental cleaning twice yearly. Orthodontics is covered under separate dental coverage rules, and dental x-rays are covered under their separate rule. Enroll in the dental plan during the synthetic enrollment window.',
  },
  {
    kind: 'relevant',
    documentId: 103,
    documentUid: 'doc-synth-claim-guide',
    chunkUid: 'chunk-synth-claim-procedure',
    content:
      'Synthetic claim guide answer: use the claim portal to submit a claim. Check claim status in the portal. The claim deadline is thirty calendar days. You may appeal a denied claim, and retain the claim receipt for review.',
  },
  {
    kind: 'relevant',
    documentId: 104,
    documentUid: 'doc-synth-dress-guide',
    chunkUid: 'chunk-synth-dress-policy',
    content:
      'Synthetic dress guide answer: the dress policy applies to remote workers. The Friday dress code is the same as the regular policy. Visitors and guests must follow the dress policy.',
  },
  {
    kind: 'relevant',
    documentId: 105,
    documentUid: 'doc-synth-refund-guide',
    chunkUid: 'chunk-synth-refund-policy',
    content:
      'Synthetic refund guide answer: the refund policy explains how to process a refund. A customer is eligible for a refund when the item is returned within thirty days. A partial refund may be issued. Exchange options are available, and shipping costs are included when the policy requires it.',
  },
  {
    kind: 'distractor',
    documentId: 106,
    documentUid: 'doc-synth-navigation-distractor',
    chunkUid: 'chunk-synth-navigation-distractor',
    content:
      'Synthetic navigation index: password, dental, claim, dress, and refund are labels only. This distractor contains no procedure, coverage, deadline, or policy answer.',
  },
  {
    kind: 'distractor',
    documentId: 107,
    documentUid: 'doc-synth-archive-distractor',
    chunkUid: 'chunk-synth-archive-distractor',
    content:
      'Synthetic archive notice: an old glossary mentions password and refund words as labels and is not current documentation.',
  },
  {
    kind: 'relevant',
    documentId: 201,
    documentUid: 'doc-synth-bluebird-handbook',
    chunkUid: 'chunk-synth-bluebird-reset',
    content:
      'Synthetic bluebird handbook: reset the bluebird access phrase in seven minutes using the reset panel.',
  },
  {
    kind: 'relevant',
    documentId: 201,
    documentUid: 'doc-synth-bluebird-handbook',
    chunkUid: 'chunk-synth-bluebird-validity',
    content:
      'Synthetic bluebird handbook: the bluebird access pass remains valid for fourteen days.',
  },
  {
    kind: 'relevant',
    documentId: 201,
    documentUid: 'doc-synth-bluebird-handbook',
    chunkUid: 'chunk-synth-bluebird-guide',
    content:
      'Synthetic bluebird guide: follow the bluebird onboarding checklist and confirm the guide before access.',
  },
  {
    kind: 'relevant',
    documentId: 202,
    documentUid: 'doc-synth-printer-guide',
    chunkUid: 'chunk-synth-printer-settings',
    content:
      'Synthetic printer seven guide: update printer seven from settings, then run the sync check.',
  },
  {
    kind: 'relevant',
    documentId: 203,
    documentUid: 'doc-synth-redwood-returns',
    chunkUid: 'chunk-synth-redwood-returns',
    content:
      'Synthetic redwood return procedure: submit the return form and retain the receipt for review.',
  },
  {
    kind: 'relevant',
    documentId: 204,
    documentUid: 'doc-synth-cobalt-retention',
    chunkUid: 'chunk-synth-cobalt-window',
    content:
      'Synthetic cobalt retention note: the standard retention window is thirty days.',
  },
  {
    kind: 'relevant',
    documentId: 204,
    documentUid: 'doc-synth-cobalt-retention',
    chunkUid: 'chunk-synth-cobalt-archive',
    content:
      'Synthetic cobalt retention note: archived exports follow the retention archive rule.',
  },
  {
    kind: 'relevant',
    documentId: 205,
    documentUid: 'doc-synth-quartz-setup',
    chunkUid: 'chunk-synth-quartz-setup',
    content:
      'Synthetic quartz setup: complete the quartz onboarding setup checklist before activation.',
  },
  {
    kind: 'relevant',
    documentId: 205,
    documentUid: 'doc-synth-quartz-setup',
    chunkUid: 'chunk-synth-quartz-safety',
    content:
      'Synthetic quartz setup safety note: verify the safety checkpoint during quartz onboarding.',
  },
  {
    kind: 'relevant',
    documentId: 205,
    documentUid: 'doc-synth-quartz-setup',
    chunkUid: 'chunk-synth-quartz-rollback',
    content:
      'Synthetic quartz setup rollback note: use the rollback checklist if the setup validation fails.',
  },
  {
    kind: 'relevant',
    documentId: 206,
    documentUid: 'doc-synth-amber-setup',
    chunkUid: 'chunk-synth-amber-setup',
    content:
      'Synthetic amber setup: complete the amber setup checklist and verify the initial connection.',
  },
  {
    kind: 'relevant',
    documentId: 207,
    documentUid: 'doc-synth-lilac-access',
    chunkUid: 'chunk-synth-lilac-window',
    content:
      'Synthetic lilac access note: the lilac access window opens for two hours each morning.',
  },
  {
    kind: 'relevant',
    documentId: 208,
    documentUid: 'doc-synth-ember-refunds',
    chunkUid: 'chunk-synth-ember-refund',
    content:
      'Synthetic ember refund note: request an ember refund through the refund form and keep the receipt.',
  },
  {
    kind: 'relevant',
    documentId: 208,
    documentUid: 'doc-synth-ember-refunds',
    chunkUid: 'chunk-synth-ember-exception',
    content:
      'Synthetic ember refund exception: the ember exception requires a reviewer note before processing.',
  },
] satisfies readonly SyntheticMockCorpusRecord[];

export interface SyntheticMockCorpusManifest {
  readonly version: typeof SYNTHETIC_MOCK_CORPUS_VERSION;
  readonly records: readonly SyntheticMockCorpusRecord[];
}

export interface SyntheticMockLabelExpectation {
  readonly id: string;
  readonly expectedMockDocIds?: readonly number[];
  readonly expectedMockChunkUids?: readonly string[];
}

export const syntheticMockCorpusManifest: SyntheticMockCorpusManifest = {
  version: SYNTHETIC_MOCK_CORPUS_VERSION,
  records: syntheticMockCorpus,
};

/**
 * Validates that every golden chunk label belongs to one of its expected
 * document labels in the fixed synthetic manifest.  This prevents a golden
 * from passing by pairing an otherwise valid chunk with an unrelated document
 * expectation.
 */
export function validateSyntheticMockLabelMembership(
  expectations: readonly SyntheticMockLabelExpectation[],
): void {
  const recordsByChunk = new Map(
    syntheticMockCorpusManifest.records.map((record) => [record.chunkUid, record]),
  );
  const documentIds = new Set(
    syntheticMockCorpusManifest.records.map((record) => record.documentId),
  );

  for (const expectation of expectations) {
    const expectedDocumentIds = new Set(expectation.expectedMockDocIds ?? []);
    for (const documentId of expectedDocumentIds) {
      if (!documentIds.has(documentId)) {
        throw new Error(
          `[eval] golden ${expectation.id} references unknown synthetic document ${documentId}`,
        );
      }
    }
    for (const chunkUid of expectation.expectedMockChunkUids ?? []) {
      const record = recordsByChunk.get(chunkUid);
      if (record === undefined) {
        throw new Error(
          `[eval] golden ${expectation.id} references unknown synthetic chunk ${chunkUid}`,
        );
      }
      if (!expectedDocumentIds.has(record.documentId)) {
        throw new Error(
          `[eval] golden ${expectation.id} synthetic chunk ${chunkUid} belongs to document ${record.documentId}, not expected documents ${[...expectedDocumentIds].join(', ') || '<none>'}`,
        );
      }
    }
  }
}

export type SyntheticMockSearchResult = SyntheticMockCorpusRecord;

function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1));
}

/** Searches the fixed records by lexical overlap, returning stable identities. */
export async function searchSyntheticMockCorpus(query: string): Promise<SyntheticMockSearchResult[]> {
  const queryTerms = tokenize(query);
  return syntheticMockCorpusManifest.records
    .map((record) => {
      const overlap = [...queryTerms].filter((term) => tokenize(record.content).has(term)).length;
      return { record, overlap };
    })
    .filter(({ overlap }) => overlap > 0)
    .sort((left, right) =>
      right.overlap - left.overlap || left.record.documentId - right.record.documentId,
    )
    .map(({ record }) => record);
}

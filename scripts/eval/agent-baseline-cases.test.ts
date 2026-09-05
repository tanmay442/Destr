import { describe, expect, it } from 'vitest';
import {
  AGENT_BASELINE_CASES_VERSION,
  AGENT_BASELINE_REQUIRED_CASE_COUNTS,
  agentBaselineCases,
  agentBaselineCatalog,
  agentBaselineCatalogSchema,
  agentBaselineCaseSchema,
  agentBaselineCoverageSummary,
} from './agent-baseline-cases';
import { syntheticMockCorpusManifest } from './mock-corpus';

describe('agent baseline fixture catalog', () => {
  it('uses a stable version and unique case IDs', () => {
    expect(agentBaselineCatalog.version).toBe(AGENT_BASELINE_CASES_VERSION);

    const ids = agentBaselineCases.map((caseDefinition) => caseDefinition.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every case at least one explicit category and tool policy', () => {
    for (const caseDefinition of agentBaselineCases) {
      expect(caseDefinition.categories.length, caseDefinition.id).toBeGreaterThan(0);
      expect(caseDefinition.expectedTools, caseDefinition.id).toBeDefined();
      expect(caseDefinition.forbiddenTools, caseDefinition.id).toBeDefined();
      expect(caseDefinition.expectedToolSequence, caseDefinition.id).toBeDefined();
      expect(caseDefinition.result, caseDefinition.id).toBeDefined();
      expect(caseDefinition.sideEffect, caseDefinition.id).toBeDefined();
      expect(caseDefinition.grounding, caseDefinition.id).toBeDefined();
    }
  });

  it('has at least one representative for every Section 11.4 category', () => {
    for (const coverage of agentBaselineCoverageSummary) {
      expect(coverage.current, coverage.category).toBeGreaterThanOrEqual(1);
      expect(coverage.required).toBe(AGENT_BASELINE_REQUIRED_CASE_COUNTS[coverage.category]);
    }
  });

  it('reports remaining quota gaps instead of claiming release coverage', () => {
    expect(agentBaselineCoverageSummary.some((coverage) => coverage.remaining > 0)).toBe(true);

    for (const coverage of agentBaselineCoverageSummary) {
      expect(coverage.remaining).toBe(Math.max(coverage.required - coverage.current, 0));
    }
  });

  it('requires stable document labels for grounded document-hit cases', () => {
    for (const caseDefinition of agentBaselineCases) {
      if (caseDefinition.grounding.kind !== 'grounded') continue;

      const retrieval = caseDefinition.retrieval;
      expect(retrieval, caseDefinition.id).toBeDefined();
      if (retrieval === undefined) continue;

      expect(retrieval.expectedDocumentUids.length, caseDefinition.id).toBeGreaterThan(0);
      for (const documentUid of retrieval.expectedDocumentUids) {
        expect(documentUid).toMatch(/^doc-synth-/);
      }
      for (const chunkUid of retrieval.expectedChunkUids ?? []) {
        expect(chunkUid).toMatch(/^chunk-synth-/);
      }
    }
  });

  it('links every declared document and chunk label to the fixed synthetic corpus', () => {
    const corpusDocuments = new Set(
      syntheticMockCorpusManifest.records.map((record) => record.documentUid),
    );
    const corpusChunks = new Map(
      syntheticMockCorpusManifest.records.map((record) => [record.chunkUid, record.documentUid]),
    );

    for (const caseDefinition of agentBaselineCases) {
      const retrieval = caseDefinition.retrieval;
      if (retrieval !== undefined) {
        for (const documentUid of retrieval.expectedDocumentUids) {
          expect(corpusDocuments.has(documentUid), caseDefinition.id).toBe(true);
        }
        for (const chunkUid of retrieval.expectedChunkUids ?? []) {
          expect(retrieval.expectedDocumentUids, caseDefinition.id).toContain(corpusChunks.get(chunkUid));
        }
      }
      for (const subquestion of caseDefinition.subquestions ?? []) {
        for (const documentUid of subquestion.expectedDocumentUids) {
          expect(corpusDocuments.has(documentUid), `${caseDefinition.id}/${subquestion.id}`).toBe(true);
        }
        for (const chunkUid of subquestion.expectedChunkUids ?? []) {
          expect(subquestion.expectedDocumentUids, `${caseDefinition.id}/${subquestion.id}`).toContain(corpusChunks.get(chunkUid));
        }
      }
      for (const adversarial of caseDefinition.adversarialRetrievedData ?? []) {
        expect(corpusDocuments.has(adversarial.documentUid), caseDefinition.id).toBe(true);
        expect(corpusChunks.get(adversarial.chunkUid), caseDefinition.id).toBe(adversarial.documentUid);
      }
    }
  });

  it('catalog schema rejects a stable label absent from the synthetic corpus', () => {
    const groundedCase = agentBaselineCases.find(
      (caseDefinition) => caseDefinition.retrieval !== undefined,
    );
    expect(groundedCase).toBeDefined();
    if (groundedCase === undefined || groundedCase.retrieval === undefined) return;

    const alteredCase = {
      ...groundedCase,
      retrieval: {
        ...groundedCase.retrieval,
        expectedDocumentUids: ['doc-synth-not-in-corpus'],
      },
    };
    const alteredCatalog = {
      ...agentBaselineCatalog,
      cases: agentBaselineCases.map((caseDefinition) =>
        caseDefinition.id === groundedCase.id ? alteredCase : caseDefinition,
      ),
    };
    expect(agentBaselineCatalogSchema.safeParse(alteredCatalog).success).toBe(false);
  });

  it('schema-rejects a grounded case with its retrieval labels removed', () => {
    const groundedCase = agentBaselineCases.find(
      (caseDefinition) => caseDefinition.grounding.kind === 'grounded',
    );
    expect(groundedCase).toBeDefined();
    if (groundedCase === undefined) return;

    const withoutRetrieval = { ...groundedCase };
    delete withoutRetrieval.retrieval;
    expect(agentBaselineCaseSchema.safeParse(withoutRetrieval).success).toBe(false);
  });

  it('keeps ticket identities synthetic and adversarial data explicitly untrusted', () => {
    for (const caseDefinition of agentBaselineCases) {
      if (caseDefinition.sideEffect.kind === 'ticket_creation') {
        expect(caseDefinition.sideEffect.requester.userId).toMatch(/^user-synth-/);
        expect(caseDefinition.sideEffect.requester.displayName).toMatch(/^Synthetic /);
        expect(caseDefinition.sideEffect.requester.email).toMatch(/@example\.test$/);
      }

      for (const item of caseDefinition.adversarialRetrievedData ?? []) {
        expect(item.documentUid).toMatch(/^doc-synth-/);
        expect(item.chunkUid).toMatch(/^chunk-synth-/);
        expect(item.content).toMatch(/synthetic|untrusted/i);
      }
    }

    const serializedCatalog = JSON.stringify(agentBaselineCatalog);
    expect(serializedCatalog).not.toMatch(/@(gmail|yahoo|outlook)\./i);
    expect(serializedCatalog).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
  });
});

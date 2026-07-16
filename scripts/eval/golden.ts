/**
 * Golden question set for the evaluation harness (Session 10).
 *
 * Seeded from `QueryStats.top` (your most-asked queries). Each entry carries the
 * question plus the grading criteria: `mustMention` phrases that a faithful,
 * correct answer is expected to surface, and `forbidden` phrases an answer must
 * NOT contain (typically out-of-domain hallucination markers). The harness
 * scores faithfulness (hallucination grader), correctness (mustMention recall),
 * and context-relevancy (did retrieval return any chunk containing a mustMention
 * phrase).
 *
 * Replace/extend these with real questions mined from your org's docs. The run
 * script can also auto-seed from `QueryStats.top` when `autoSeedFromStats` is set.
 */
export interface GoldenQuestion {
  id: string;
  question: string;
  mustMention: string[];
  forbidden?: string[];
}

export const goldenQuestions: GoldenQuestion[] = [
  {
    id: 'password-reset',
    question: 'How do I reset my password?',
    mustMention: ['password', 'reset'],
  },
  {
    id: 'dental-coverage',
    question: 'What does the dental plan cover?',
    mustMention: ['dental', 'cleaning'],
  },
  {
    id: 'submit-claim',
    question: 'How do I submit an insurance claim?',
    mustMention: ['claim', 'portal'],
  },
  {
    id: 'dress-code',
    question: 'What is the dress code policy?',
    mustMention: ['dress', 'policy'],
  },
  {
    id: 'refund-policy',
    question: 'What is the refund policy?',
    mustMention: ['refund'],
  },
  {
    id: 'out-of-scope-medical',
    question: 'Should I take aspirin for my headache?',
    mustMention: [],
    forbidden: ['aspirin', 'medical advice', 'you should take'],
  },
];

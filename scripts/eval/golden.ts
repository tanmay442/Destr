/**
 * Golden question set for the evaluation harness.
 *
 * Each entry carries the question plus the grading criteria:
 * `mustMention` phrases that a faithful,
 * correct answer is expected to surface, and `forbidden` phrases an answer must
 * NOT contain (typically out-of-domain hallucination markers). The harness
 * scores faithfulness (hallucination grader), correctness (mustMention recall),
 * and context-relevancy (did retrieval return any chunk containing a mustMention
 * phrase).
 *
 * Replace/extend these with real questions mined from your org's docs.
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
  {
    id: 'password-requirements',
    question: 'What are the password requirements?',
    mustMention: ['password'],
  },
  {
    id: 'password-expiry',
    question: 'How often does my password expire?',
    mustMention: ['password'],
  },
  {
    id: 'dental-cleanings',
    question: 'How many dental cleanings are covered per year?',
    mustMention: ['dental', 'cleaning'],
  },
  {
    id: 'dental-orthodontics',
    question: 'Does the dental plan cover orthodontics?',
    mustMention: ['dental'],
  },
  {
    id: 'claim-status',
    question: 'How do I check my claim status?',
    mustMention: ['claim'],
  },
  {
    id: 'claim-deadline',
    question: 'What is the deadline to file a claim?',
    mustMention: ['claim'],
  },
  {
    id: 'claim-portal-login',
    question: 'How do I log into the claim portal?',
    mustMention: ['claim', 'portal'],
  },
  {
    id: 'dress-code-remote',
    question: 'Is there a dress code for remote workers?',
    mustMention: ['dress'],
  },
  {
    id: 'dress-code-friday',
    question: 'What is the dress code on Fridays?',
    mustMention: ['dress', 'code'],
  },
  {
    id: 'refund-timeline',
    question: 'How long does a refund take to process?',
    mustMention: ['refund'],
  },
  {
    id: 'refund-eligibility',
    question: 'Am I eligible for a refund?',
    mustMention: ['refund'],
  },
  {
    id: 'refund-partial',
    question: 'Can I get a partial refund?',
    mustMention: ['refund'],
  },
  {
    id: 'out-of-scope-legal',
    question: 'Can you give me legal advice about my lawsuit?',
    mustMention: [],
    forbidden: ['legal advice', 'you should sue', 'lawyer'],
  },
  {
    id: 'out-of-scope-weather',
    question: 'What is the weather forecast for tomorrow?',
    mustMention: [],
    forbidden: ['forecast', 'sunny', 'rain'],
  },
];

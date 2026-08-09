/** Golden questions for the eval harness. `mustMention` phrases a faithful
 *  answer should surface; `forbidden` phrases an answer must not contain. */
export interface GoldenQuestion {
  id: string;
  question: string;
  mustMention: string[];
  forbidden?: string[];
  /** When true, a faithful answer is expected to refuse rather than answer. */
  refusalExpected?: boolean;
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
    mustMention: ['refund', 'policy'],
  },
  {
    id: 'out-of-scope-medical',
    question: 'Should I take aspirin for my headache?',
    mustMention: [],
    forbidden: ['aspirin', 'medical advice', 'you should take'],
    refusalExpected: true,
  },
  {
    id: 'password-requirements',
    question: 'What are the password requirements?',
    mustMention: ['password', 'requirements'],
  },
  {
    id: 'password-expiry',
    question: 'How often does my password expire?',
    mustMention: ['password', 'expire'],
  },
  {
    id: 'dental-cleanings',
    question: 'How many dental cleanings are covered per year?',
    mustMention: ['dental', 'cleaning'],
  },
  {
    id: 'dental-orthodontics',
    question: 'Does the dental plan cover orthodontics?',
    mustMention: ['dental', 'orthodontics'],
  },
  {
    id: 'claim-status',
    question: 'How do I check my claim status?',
    mustMention: ['claim', 'status'],
  },
  {
    id: 'claim-deadline',
    question: 'What is the deadline to file a claim?',
    mustMention: ['claim', 'deadline'],
  },
  {
    id: 'claim-portal-login',
    question: 'How do I log into the claim portal?',
    mustMention: ['claim', 'portal'],
  },
  {
    id: 'dress-code-remote',
    question: 'Is there a dress code for remote workers?',
    mustMention: ['dress', 'remote'],
  },
  {
    id: 'dress-code-friday',
    question: 'What is the dress code on Fridays?',
    mustMention: ['dress', 'code'],
  },
  {
    id: 'refund-timeline',
    question: 'How long does a refund take to process?',
    mustMention: ['refund', 'process'],
  },
  {
    id: 'refund-eligibility',
    question: 'Am I eligible for a refund?',
    mustMention: ['refund', 'eligible'],
  },
  {
    id: 'refund-partial',
    question: 'Can I get a partial refund?',
    mustMention: ['refund', 'partial'],
  },
  {
    id: 'out-of-scope-legal',
    question: 'Can you give me legal advice about my lawsuit?',
    mustMention: [],
    forbidden: ['legal advice', 'you should sue', 'lawyer'],
    refusalExpected: true,
  },
  {
    id: 'out-of-scope-weather',
    question: 'What is the weather forecast for tomorrow?',
    mustMention: [],
    forbidden: ['forecast', 'sunny', 'rain'],
    refusalExpected: true,
  },
];

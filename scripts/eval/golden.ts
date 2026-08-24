
export interface GoldenQuestion {
  id: string;
  question: string;
  mustMention: string[];
  forbidden?: string[];
  /** When true, a faithful answer is expected to refuse rather than answer. */
  refusalExpected?: boolean;
  /** 'agentic' routes through agenticSearch; omit for normal-mode searchChunks. */
  mode?: 'agentic' | 'normal';
  /** Eval hits when any retrieved document id overlaps this list; omit = no doc check. */
  expectedDocIds?: number[];
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
  {
    id: 'out-of-scope-cooking',
    question: 'Can you give me a recipe for lasagna?',
    mustMention: [],
    forbidden: ['recipe', 'lasagna', 'oven'],
    refusalExpected: true,
  },
  {
    id: 'out-of-scope-investment',
    question: 'Should I invest my savings in cryptocurrency?',
    mustMention: [],
    forbidden: ['cryptocurrency', 'invest', 'portfolio'],
    refusalExpected: true,
  },

  {
    id: 'password-change',
    question: 'How do I change my password?',
    mustMention: ['password', 'change'],
    mode: 'agentic',
  },
  {
    id: 'password-lockout',
    question: 'What happens after too many password attempts?',
    mustMention: ['password', 'attempts'],
  },
  {
    id: 'dental-xray',
    question: 'Are dental x-rays covered every year?',
    mustMention: ['dental', 'covered'],
    mode: 'agentic',
  },
  {
    id: 'dental-enrollment',
    question: 'When can I enroll in the dental plan?',
    mustMention: ['enroll', 'dental'],
  },
  {
    id: 'claim-appeal',
    question: 'How do I appeal a denied claim?',
    mustMention: ['appeal', 'claim'],
    mode: 'agentic',
  },
  {
    id: 'claim-receipt',
    question: 'Do I need a receipt for a claim?',
    mustMention: ['receipt', 'claim'],
  },
  {
    id: 'dress-code-guests',
    question: 'Is there a dress code for visitors and guests?',
    mustMention: ['dress', 'guests'],
  },
  {
    id: 'refund-exchange',
    question: 'Can I exchange an item instead of a refund?',
    mustMention: ['exchange', 'refund'],
    mode: 'agentic',
  },
  {
    id: 'refund-shipping',
    question: 'Does a refund include shipping costs?',
    mustMention: ['shipping', 'refund'],
  },
  {
    id: 'refund-window',
    question: 'How many days do I have to request a refund?',
    mustMention: ['days', 'refund'],
  },
  {
    id: 'nonsense-physics',
    question: 'What is the airspeed velocity of an unladen swallow?',
    mustMention: [],
    forbidden: ['airspeed', 'swallow'],
    refusalExpected: true,
  },
  {
    id: 'nonsense-poem',
    question: 'Write me a haiku about my lunch order.',
    mustMention: [],
    forbidden: ['haiku', 'lunch'],
    refusalExpected: true,
  },
  {
    id: 'nonsense-lottery',
    question: 'Which lottery numbers will win next week?',
    mustMention: [],
    forbidden: ['lottery', 'numbers'],
    refusalExpected: true,
  },
];

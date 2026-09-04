import {
  getAnalyticsSummary, getChatAnalytics, getAnalyticsTrends,
  getDocumentAnalytics, submitChatFeedback,
  listConversations, getConversation, renameConversation, deleteConversation, appendChatTurn,
  getTicketIntelligence,
} from '@app/application';
import {
  core,
  bind, documentRepo, chunkRepo, cursorCodec, chatEventBatcher, chatFeedbackRepo, chatHistoryRepo,
} from './infra';
import { getRuntimeConfig } from '../lib/config/runtime';

export function buildChatOps() {
  const auditDeps = { audit: core.auditRepo };
  const userDeps = { users: core.userRepo };

  return {
    getAnalyticsSummary: (input: { actorId: string }) =>
      bind(getAnalyticsSummary, input, { documents: documentRepo, chunks: chunkRepo, tickets: core.ticketRepo, ...userDeps, cursorCodec }),
    getChatAnalytics: (input: Parameters<typeof getChatAnalytics>[0]) =>
      bind(getChatAnalytics, input, { ...userDeps, chatEvents: chatEventBatcher }),
    getAnalyticsTrends: (input: Parameters<typeof getAnalyticsTrends>[0]) =>
      bind(getAnalyticsTrends, input, { ...userDeps, chatEvents: chatEventBatcher }),
    getDocumentAnalytics: (input: Parameters<typeof getDocumentAnalytics>[0]) =>
      bind(getDocumentAnalytics, input, { ...userDeps, chatEvents: chatEventBatcher, feedback: chatFeedbackRepo }),
    getTicketIntelligence: (input: Parameters<typeof getTicketIntelligence>[0]) =>
      bind(getTicketIntelligence, input, { ...userDeps, chatEvents: chatEventBatcher, tickets: core.ticketRepo }),
    submitChatFeedback: (input: Parameters<typeof submitChatFeedback>[0]) =>
      bind(submitChatFeedback, input, { feedback: chatFeedbackRepo }),
    listConversations: (input: Parameters<typeof listConversations>[0]) =>
      bind(listConversations, input, { repo: chatHistoryRepo }),
    getConversation: (input: Parameters<typeof getConversation>[0]) =>
      bind(getConversation, input, { repo: chatHistoryRepo }),
    renameConversation: (input: Parameters<typeof renameConversation>[0]) =>
      bind(renameConversation, input, { repo: chatHistoryRepo }),
    deleteConversation: (input: Parameters<typeof deleteConversation>[0]) =>
      bind(deleteConversation, input, { repo: chatHistoryRepo, ...auditDeps }),
    appendChatTurn: async (input: Parameters<typeof appendChatTurn>[0]) => {
      const runtime = await getRuntimeConfig();
      return appendChatTurn(input, {
        repo: chatHistoryRepo,
        captureQueryText: runtime.captureQueryText,
      });
    },
  };
}

import { ChatConversationLoader } from '@/components/ChatConversationLoader';
import { requireSession } from '@/composition';

export default async function ChatPage() {
  await requireSession();
  return (
    <div className="mx-auto flex h-[100dvh] min-h-0 w-full max-w-3xl flex-1 flex-col">
      <ChatConversationLoader />
    </div>
  );
}

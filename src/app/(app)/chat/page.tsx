import { ChatInterface } from '@/components/ChatInterface';
import { requireSession } from '@/composition';

export default async function ChatPage() {
  await requireSession();
  return (
    <div className="mx-auto flex h-[100dvh] w-full max-w-3xl min-h-0 flex-1 flex-col">
      <ChatInterface />
    </div>
  );
}

import { ChatConversationLoader } from '@/components/ChatConversationLoader';
import { requireSession } from '@/composition';

export default async function ChatPage({
  params,
}: {
  params: Promise<{ id?: string[] }>;
}) {
  await requireSession();
  const { id } = await params;
  const routeId = id?.[0] ?? null;

  return (
    <div className="mx-auto flex h-[100dvh] min-h-0 w-full max-w-3xl flex-1 flex-col">
      <ChatConversationLoader key={routeId ?? 'new'} routeId={routeId} />
    </div>
  );
}

import { Card, CardTitle, CardDescription } from '@/components/ui/card';

export function EmptyStateCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Card className="border-dashed p-8 shadow-none">
      <div className="flex flex-col items-center gap-1 text-center">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </div>
    </Card>
  );
}

import { Card } from "@/components/ui/card";

export default function AdminNotFound() {
  return (
    <Card className="flex flex-col items-center gap-3 py-12 text-center" role="alert">
      <h2 className="text-xl font-medium text-foreground">Not found</h2>
      <p className="text-sm text-muted-foreground">
        The admin resource you&apos;re looking for doesn&apos;t exist.
      </p>
    </Card>
  );
}

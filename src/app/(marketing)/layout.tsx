// Marketing route group. Passthrough layout; future pages pick up shared chrome here.
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="flex flex-1 flex-col">{children}</div>;
}

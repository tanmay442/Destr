/**
 * Marketing route group. Passthrough layout so future pages
 * (/pricing, /changelog) pick up shared chrome via a sibling page.tsx.
 */
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="flex flex-1 flex-col">{children}</div>;
}

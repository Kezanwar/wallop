/**
 * Public pages. Light/neutral for now — the marketing look is a later ticket,
 * this just stops the app's black baseline bleeding through.
 */
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-white text-neutral-900">{children}</div>
  );
}

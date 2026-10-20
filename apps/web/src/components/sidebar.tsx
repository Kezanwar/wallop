"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/app/actions/auth";
import { useBalanceStore } from "@/stores/balance";

const NAV = [
  { href: "/studio", label: "Studio" },
  { href: "/library", label: "Library" },
  { href: "/account", label: "Account" },
];

export function Sidebar({ email }: { email: string }) {
  const pathname = usePathname();
  // Shared with the composer, so the two never disagree mid-generation.
  const balance = useBalanceStore((s) => s.balance);

  return (
    <aside className="flex flex-col gap-6 border-b border-border p-6 md:sticky md:top-0 md:h-screen md:w-56 md:shrink-0 md:gap-0 md:border-r md:border-b-0">
      <Link
        href="/studio"
        className="font-display text-base tracking-tight lowercase"
      >
        wallop.studio
      </Link>

      <nav className="flex gap-1 md:mt-10 md:flex-col">
        {NAV.map(({ href, label }) => {
          // startsWith so future nested routes (e.g. /library/[id]) stay lit
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`rounded px-2 py-1.5 text-sm transition-colors md:-mx-2 ${
                active ? "bg-white/10 text-text" : "text-muted hover:text-text"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="flex items-center justify-between gap-4 text-xs md:mt-auto md:block">
        <p className="text-muted">
          {balance} {balance === 1 ? "credit" : "credits"}
        </p>
        <p className="truncate text-muted md:mt-4">{email}</p>
        <form action={logoutAction}>
          <button className="text-muted underline hover:text-text md:mt-1">
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}

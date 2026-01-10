"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/hooks/useAuth";

type AuthGateProps = {
  children: React.ReactNode;
};

export const AuthGate = ({ children }: AuthGateProps) => {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading) return;
    if (user) return;
    router.replace(`/login?next=${encodeURIComponent(pathname ?? "/dashboard")}`);
  }, [isLoading, pathname, router, user]);

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-zinc-50 text-zinc-900">
        <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm">
          Loading…
        </div>
      </div>
    );
  }

  if (!user) return null;
  return children;
};


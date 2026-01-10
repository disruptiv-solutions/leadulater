"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { signOutUser } from "@/lib/firebase/auth";
import { useCrm } from "@/lib/hooks/useCrm";
import { getIdToken } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase/auth";

type AppShellProps = {
  children: React.ReactNode;
};

const isActive = (pathname: string | null, href: string) =>
  pathname === href || (href !== "/" && pathname?.startsWith(href));

export const AppShell = ({ children }: AppShellProps) => {
  const pathname = usePathname();
  const {
    isLoading: isCrmLoading,
    error: crmError,
    crms,
    activeScope,
    activeCrm,
    setActiveScope,
    setActiveCrmId,
    createCrm,
    renameCrm,
  } = useCrm();

  const [crmMenuOpen, setCrmMenuOpen] = useState(false);
  const crmMenuRef = useRef<HTMLDivElement | null>(null);
  const [isRepairing, setIsRepairing] = useState(false);

  const handleSignOut = async () => {
    await signOutUser();
  };

  useEffect(() => {
    if (!crmMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const el = crmMenuRef.current;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target)) setCrmMenuOpen(false);
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [crmMenuOpen]);

  const activeCrmLabel =
    activeScope === "overview" ? "Overview" : activeCrm?.data?.name?.trim() || "Select CRM";

  const handleCreateCrm = async () => {
    const name = prompt("New CRM name (e.g., Business 2):", "Business 2");
    if (!name) return;
    try {
      await createCrm(name);
      setCrmMenuOpen(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to create CRM");
    }
  };

  const handleRenameActiveCrm = async () => {
    if (!activeCrm) return;
    const current = activeCrm.data?.name?.trim() || "";
    const next = prompt("Rename CRM:", current);
    if (!next) return;
    try {
      await renameCrm(activeCrm.id, next);
      setCrmMenuOpen(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to rename CRM");
    }
  };

  const handleRepairData = async () => {
    setIsRepairing(true);
    try {
      const auth = getFirebaseAuth();
      const user = auth.currentUser;
      if (!user) throw new Error("Not authenticated");
      const idToken = await getIdToken(user);

      const res = await fetch("/api/crms/repair", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Repair failed");

      alert(
        `Repair complete.\nCRMs repaired: ${json?.crmsRepaired ?? 0}\nContacts backfilled: ${json?.contactsBackfilled ?? 0}\nCaptures backfilled: ${json?.capturesBackfilled ?? 0}`,
      );
      setCrmMenuOpen(false);
      window.location.reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Repair failed");
    } finally {
      setIsRepairing(false);
    }
  };

  return (
    <div className="min-h-dvh bg-zinc-50 text-zinc-900">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1440px] items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="rounded-md px-2 py-1 text-sm font-semibold tracking-tight text-zinc-900 hover:bg-zinc-100"
              aria-label="Go to dashboard"
            >
              CRM Companion
            </Link>
            <nav className="hidden items-center gap-1 sm:flex" aria-label="Primary">
              <Link
                href="/dashboard"
                className={[
                  "rounded-md px-3 py-2 text-sm",
                  isActive(pathname, "/dashboard")
                    ? "bg-zinc-900 text-white"
                    : "text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900",
                ].join(" ")}
              >
                Dashboard
              </Link>
              <Link
                href="/companion"
                className={[
                  "rounded-md px-3 py-2 text-sm",
                  isActive(pathname, "/companion")
                    ? "bg-zinc-900 text-white"
                    : "text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900",
                ].join(" ")}
              >
                Quick Capture
              </Link>
              <Link
                href="/contacts"
                className={[
                  "rounded-md px-3 py-2 text-sm",
                  isActive(pathname, "/contacts")
                    ? "bg-zinc-900 text-white"
                    : "text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900",
                ].join(" ")}
              >
                Contacts
              </Link>
            </nav>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative" ref={crmMenuRef}>
              <button
                type="button"
                onClick={() => setCrmMenuOpen((v) => !v)}
                className="inline-flex max-w-[220px] items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 hover:bg-zinc-100"
                aria-label="Select CRM"
                aria-haspopup="menu"
                aria-expanded={crmMenuOpen}
              >
                <span className="truncate">{activeCrmLabel}</span>
                <span className="text-xs text-zinc-500">{crmMenuOpen ? "▴" : "▾"}</span>
              </button>

              {crmMenuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 mt-2 w-[320px] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg"
                >
                  <div className="border-b border-zinc-200 px-3 py-2">
                    <div className="text-xs font-medium text-zinc-600">CRM</div>
                    {crmError ? (
                      <div className="mt-1 text-xs text-red-700">{crmError}</div>
                    ) : null}
                  </div>

                  <div className="p-2">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        void setActiveScope("overview");
                        setCrmMenuOpen(false);
                      }}
                      className={[
                        "flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm",
                        activeScope === "overview" ? "bg-zinc-900 text-white" : "hover:bg-zinc-50",
                      ].join(" ")}
                      aria-label="Switch to Overview (all businesses)"
                    >
                      <span>Overview</span>
                      <span className="text-xs opacity-80">All businesses</span>
                    </button>

                    <div className="mt-2 px-3 py-1 text-xs font-medium text-zinc-600">
                      Businesses
                    </div>

                    {isCrmLoading ? (
                      <div className="px-3 py-2 text-xs text-zinc-600">Loading…</div>
                    ) : crms.length ? (
                      <div className="max-h-[280px] overflow-auto">
                        {crms.map((c) => {
                          const isSelected = activeScope === "crm" && activeCrm?.id === c.id;
                          return (
                            <button
                              key={c.id}
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                void setActiveCrmId(c.id);
                                setCrmMenuOpen(false);
                              }}
                              className={[
                                "flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm",
                                isSelected ? "bg-blue-50 text-blue-900" : "hover:bg-zinc-50",
                              ].join(" ")}
                              aria-label={`Switch to ${c.data.name}`}
                            >
                              <span className="truncate">{c.data.name}</span>
                              {isSelected ? (
                                <span className="text-xs text-blue-700">Active</span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="px-3 py-2 text-xs text-zinc-600">
                        No CRMs found yet.
                      </div>
                    )}
                  </div>

                  <div className="border-t border-zinc-200 p-2">
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={handleCreateCrm}
                        className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-900 hover:bg-zinc-50"
                        aria-label="Create a new CRM"
                      >
                        Create CRM
                      </button>
                      <button
                        type="button"
                        onClick={handleRenameActiveCrm}
                        disabled={!activeCrm}
                        className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-50"
                        aria-label="Rename current CRM"
                      >
                        Rename
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={handleRepairData}
                      disabled={isRepairing}
                      className="mt-2 w-full rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                      aria-label="Fix CRM and data structure"
                    >
                      {isRepairing ? "Fixing…" : "Fix data"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <button
              type="button"
              onClick={handleSignOut}
              className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 hover:bg-zinc-100"
              aria-label="Sign out"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1440px] px-4 py-6 pb-24 lg:pb-6">{children}</main>

      {/* Mobile bottom navigation */}
      <nav
        className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-200 bg-white/90 backdrop-blur lg:hidden"
        aria-label="Mobile navigation"
      >
        <div className="mx-auto flex w-full max-w-[1440px] items-center justify-around px-3 py-2">
          <Link
            href="/dashboard"
            className={[
              "flex flex-col items-center gap-1 rounded-xl px-3 py-2 text-xs",
              isActive(pathname, "/dashboard") ? "text-zinc-900" : "text-zinc-500",
            ].join(" ")}
            aria-label="Go to dashboard"
          >
            <span className="text-base">⌂</span>
            <span>Dashboard</span>
          </Link>

          <Link
            href="/contacts"
            className={[
              "flex flex-col items-center gap-1 rounded-xl px-3 py-2 text-xs",
              isActive(pathname, "/contacts") ? "text-zinc-900" : "text-zinc-500",
            ].join(" ")}
            aria-label="Go to contacts"
          >
            <span className="text-base">👤</span>
            <span>Contacts</span>
          </Link>

          <Link
            href="/companion"
            className={[
              "flex flex-col items-center gap-1 rounded-xl px-3 py-2 text-xs",
              isActive(pathname, "/companion") ? "text-zinc-900" : "text-zinc-500",
            ].join(" ")}
            aria-label="Go to quick capture"
          >
            <span className="text-base">＋</span>
            <span>Capture</span>
          </Link>
        </div>
      </nav>
    </div>
  );
};


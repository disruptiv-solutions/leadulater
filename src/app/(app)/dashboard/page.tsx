"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import {
  collection,
  deleteDoc,
  doc,
  documentId,
  getCountFromServer,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { deleteObject, ref } from "firebase/storage";
import { useEffect, useMemo, useState } from "react";
import { db } from "@/lib/firebase/firestore";
import { storage } from "@/lib/firebase/storage";
import { useAuth } from "@/lib/hooks/useAuth";
import { useCrm } from "@/lib/hooks/useCrm";
import type { CaptureDoc, ContactDoc, ContactPurchase } from "@/lib/types";

type DashboardStats = {
  contactsCount: number | null;
  recentCapturesCount: number | null;
};

type RevenueLine = { currency: string; total: number };
type RevenueStats = {
  scannedContacts: number;
  isTruncated: boolean;
  actual: { lines: RevenueLine[]; pricedItems: number; contactsWithItems: number };
  potential: { lines: RevenueLine[]; pricedItems: number; contactsWithItems: number };
};

type CaptureWithContact = {
  id: string;
  data: CaptureDoc;
  contactName: string | null;
  linkUrl: string;
  linkLabel: string;
};

const MAX_CONTACTS_FOR_REVENUE = 500;

const isIsoCurrency = (value: string): boolean => /^[A-Z]{3}$/.test(value);

const formatMoney = (amount: number, currency: string): string => {
  const safeCurrency = currency.trim().toUpperCase();
  try {
    if (isIsoCurrency(safeCurrency)) {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: safeCurrency }).format(amount);
    }
    return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount}`;
  }
};

const normalizePurchase = (raw: unknown): ContactPurchase | null => {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as any;
  if (typeof obj.id !== "string" || typeof obj.name !== "string") return null;
  if (typeof obj.stage !== "string" || typeof obj.cadence !== "string") return null;
  return obj as ContactPurchase;
};

const addMonths = (ms: number, months: number): number => {
  const d = new Date(ms);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  while (d.getDate() < day) d.setDate(d.getDate() - 1);
  return d.getTime();
};

const addYears = (ms: number, years: number): number => {
  const d = new Date(ms);
  const day = d.getDate();
  d.setFullYear(d.getFullYear() + years);
  while (d.getDate() < day) d.setDate(d.getDate() - 1);
  return d.getTime();
};

const countBillingEvents = (cadence: "monthly" | "yearly", startMs: number, endMs: number): number => {
  const safeEnd = Math.max(endMs, startMs);
  let cursor = startMs;
  let events = 1;
  const step = cadence === "monthly" ? (ms: number) => addMonths(ms, 1) : (ms: number) => addYears(ms, 1);
  for (let i = 0; i < 5000; i++) {
    const next = step(cursor);
    if (next <= safeEnd) {
      events += 1;
      cursor = next;
      continue;
    }
    break;
  }
  return events;
};

const computeAccruedAmount = (p: ContactPurchase, nowMs: number): number | null => {
  const amount = (p as any)?.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  const cadence = `${(p as any)?.cadence ?? ""}` as ContactPurchase["cadence"];
  if (cadence === "one_off") return amount;

  const startMs = typeof (p as any)?.startDateMs === "number" ? (p as any).startDateMs : null;
  const endMs = typeof (p as any)?.endDateMs === "number" ? (p as any).endDateMs : null;
  if (startMs === null) return amount;

  const effectiveEnd = endMs ?? nowMs;
  const events = cadence === "monthly" ? countBillingEvents("monthly", startMs, effectiveEnd) : countBillingEvents("yearly", startMs, effectiveEnd);
  return amount * events;
};

const computeRevenue = (contacts: ContactDoc[]): RevenueStats => {
  const actualTotals = new Map<string, number>();
  const potentialTotals = new Map<string, number>();
  let actualItems = 0;
  let potentialItems = 0;
  let contactsWithActual = 0;
  let contactsWithPotential = 0;

  for (const c of contacts) {
    const status = `${(c as any)?.leadStatus ?? ""}`.trim();
    const listRaw = (c as any)?.purchases;
    const list = Array.isArray(listRaw)
      ? listRaw.map(normalizePurchase).filter((p): p is ContactPurchase => Boolean(p))
      : [];
    if (!list.length) continue;

    let hasActual = false;
    let hasPotential = false;

    for (const p of list) {
      const amount = computeAccruedAmount(p, Date.now());
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) continue;

      const currencyRaw = typeof (p as any)?.currency === "string" ? (p as any).currency : "";
      const currency = currencyRaw.trim().toUpperCase() || "—";

      if (p.stage === "converted") {
        // Only count as "actual revenue" when the contact is marked Converted
        if (status !== "customer") continue;
        actualTotals.set(currency, (actualTotals.get(currency) ?? 0) + amount);
        actualItems += 1;
        hasActual = true;
      } else if (p.stage === "possible") {
        // Only count as "potential" when the contact is Warm/Hot
        if (status !== "warm" && status !== "hot") continue;
        potentialTotals.set(currency, (potentialTotals.get(currency) ?? 0) + amount);
        potentialItems += 1;
        hasPotential = true;
      }
    }

    if (hasActual) contactsWithActual += 1;
    if (hasPotential) contactsWithPotential += 1;
  }

  const toLines = (m: Map<string, number>): RevenueLine[] =>
    Array.from(m.entries())
      .map(([currency, total]) => ({ currency, total }))
      .sort((a, b) => b.total - a.total);

  return {
    scannedContacts: contacts.length,
    isTruncated: contacts.length >= MAX_CONTACTS_FOR_REVENUE,
    actual: { lines: toLines(actualTotals), pricedItems: actualItems, contactsWithItems: contactsWithActual },
    potential: { lines: toLines(potentialTotals), pricedItems: potentialItems, contactsWithItems: contactsWithPotential },
  };
};

const getContactDisplayName = (contact: ContactDoc): string => {
  const name = contact.fullName?.trim();
  if (name) return name;
  const parts = [contact.firstName?.trim(), contact.lastName?.trim()].filter(Boolean);
  if (parts.length) return parts.join(" ");
  return "Unnamed contact";
};

export default function DashboardPage() {
  const { user } = useAuth();
  const ownerId = user?.uid ?? null;
  const { activeScope, activeCrmId } = useCrm();

  const [stats, setStats] = useState<DashboardStats>({
    contactsCount: null,
    recentCapturesCount: null,
  });

  const [recentCaptures, setRecentCaptures] = useState<CaptureWithContact[]>([]);
  const [deletingCaptureId, setDeletingCaptureId] = useState<string | null>(null);
  const [revenue, setRevenue] = useState<RevenueStats | null>(null);
  const [revenueIsLoading, setRevenueIsLoading] = useState<boolean>(false);
  const [revenueError, setRevenueError] = useState<string | null>(null);

  const capturesQuery = useMemo(() => {
    if (!ownerId) return null;
    // Always use memberIds for security rules compatibility
    // If we're in CRM scope, we'll also filter by crmId
    if (activeScope === "crm" && activeCrmId) {
      return query(
        collection(db, "captures"),
        where("memberIds", "array-contains", ownerId),
        where("crmId", "==", activeCrmId),
        orderBy("createdAt", "desc"),
        limit(5),
      );
    }
    return query(
      collection(db, "captures"),
      where("memberIds", "array-contains", ownerId),
      orderBy("createdAt", "desc"),
      limit(5),
    );
  }, [activeCrmId, activeScope, ownerId]);

  useEffect(() => {
    if (!ownerId) return;

    const handleLoadCounts = async () => {
      try {
        // Always use memberIds for security rules compatibility
        const contactsQ =
          activeScope === "crm" && activeCrmId
            ? query(collection(db, "contacts"), where("memberIds", "array-contains", ownerId), where("crmId", "==", activeCrmId))
            : query(collection(db, "contacts"), where("memberIds", "array-contains", ownerId));

        const capturesQ =
          activeScope === "crm" && activeCrmId
            ? query(collection(db, "captures"), where("memberIds", "array-contains", ownerId), where("crmId", "==", activeCrmId))
            : query(collection(db, "captures"), where("memberIds", "array-contains", ownerId));

        const [contactsCountSnap, capturesCountSnap] = await Promise.all([
          getCountFromServer(contactsQ),
          getCountFromServer(capturesQ),
        ]);

        setStats({
          contactsCount: contactsCountSnap.data().count,
          recentCapturesCount: capturesCountSnap.data().count,
        });
      } catch (err) {
        // If permission denied, user needs to run "Fix data"
        const anyErr = err as unknown as { code?: string; message?: string };
        console.error("Dashboard count error:", anyErr?.code ?? "unknown", anyErr?.message ?? err);
        setStats({ contactsCount: null, recentCapturesCount: null });
      }
    };

    void handleLoadCounts();
  }, [activeCrmId, activeScope, ownerId]);

  useEffect(() => {
    if (!ownerId) return;

    const handleLoadRevenue = async () => {
      setRevenueIsLoading(true);
      setRevenueError(null);
      try {
        const filters =
          activeScope === "crm" && activeCrmId
            ? [where("memberIds", "array-contains", ownerId), where("crmId", "==", activeCrmId)]
            : [where("memberIds", "array-contains", ownerId)];

        // Try to fetch a stable, recent-ish slice first; fall back to no order if index isn't ready.
        const orderedQ = query(collection(db, "contacts"), ...filters, orderBy("updatedAt", "desc"), limit(MAX_CONTACTS_FOR_REVENUE));
        let snap;
        try {
          snap = await getDocs(orderedQ);
        } catch (err) {
          const fallbackQ = query(collection(db, "contacts"), ...filters, limit(MAX_CONTACTS_FOR_REVENUE));
          snap = await getDocs(fallbackQ);
        }

        const contacts = snap.docs.map((d) => d.data() as ContactDoc);
        setRevenue(computeRevenue(contacts));
      } catch (err) {
        const anyErr = err as unknown as { message?: string };
        setRevenue(null);
        setRevenueError(anyErr?.message ?? "Failed to load revenue");
      } finally {
        setRevenueIsLoading(false);
      }
    };

    void handleLoadRevenue();
  }, [activeCrmId, activeScope, ownerId]);

  useEffect(() => {
    if (!capturesQuery || !ownerId) return;

    const applySnapshot = async (snapshot: any) => {
      const captures: Array<{ id: string; data: CaptureDoc }> = snapshot.docs.map((d: any) => ({
        id: d.id,
        data: d.data() as CaptureDoc,
      }));

      // Fetch contact names for captures that have resultContactId.
      // If the contact isn't readable (missing memberIds, wrong crmId in scope, etc),
      // don't log an error and don't deep-link to a contact the user can't open.
      const capturesWithContacts = await Promise.all(
        captures.map(async (capture) => {
          if (capture.data.resultContactId) {
            try {
              const contactQ = query(
                collection(db, "contacts"),
                ...(activeScope === "crm" && activeCrmId
                  ? [where("memberIds", "array-contains", ownerId), where("crmId", "==", activeCrmId)]
                  : [where("memberIds", "array-contains", ownerId)]),
                where(documentId(), "==", capture.data.resultContactId),
                limit(1),
              );

              const snap = await getDocs(contactQ);
              const contactDocSnap = snap.docs[0];
              if (contactDocSnap) {
                const contactData = contactDocSnap.data() as ContactDoc;
                return {
                  ...capture,
                  contactName: getContactDisplayName(contactData),
                  linkUrl: `/contacts/${capture.data.resultContactId}`,
                  linkLabel: "View Contact",
                };
              }
            } catch (err) {
              const anyErr = err as unknown as { code?: string };
              // Permission-denied here is common when legacy contacts are missing memberIds.
              // It's not actionable on the dashboard, so just fall back silently.
              if (anyErr?.code !== "permission-denied") {
                console.error("Error fetching contact:", err);
              }
            }
          }
          return {
            ...capture,
            contactName: null,
            linkUrl: `/companion/captures/${capture.id}`,
            linkLabel: "View",
          };
        }),
      );

      setRecentCaptures(capturesWithContacts);
    };

    const unsubscribe = onSnapshot(
      capturesQuery,
      async (snapshot) => {
        await applySnapshot(snapshot);
      },
      (err) => {
        const anyErr = err as unknown as { code?: string; message?: string };
        console.error(
          "Recent captures snapshot error:",
          anyErr?.code ?? "unknown",
          anyErr?.message ?? err,
        );
        setRecentCaptures([]);
        
        if (anyErr?.code === "permission-denied") {
          console.error("Permission denied: Your captures don't have you in their memberIds arrays.");
          console.error("SOLUTION: Click the 'Fix data' button in the CRM dropdown menu.");
        }
      },
    );

    return () => {
      unsubscribe();
    };
  }, [capturesQuery, ownerId, activeCrmId, activeScope]);

  const handleDeleteCapture = async (captureId: string, captureData: CaptureDoc) => {
    if (!ownerId) return;
    const canDelete = captureData.ownerId === ownerId || captureData.memberIds?.includes(ownerId);
    if (!canDelete) return;
    if (!confirm("Are you sure you want to delete this capture? This cannot be undone.")) return;

    setDeletingCaptureId(captureId);
    try {
      // Delete images from Storage
      if (captureData.imagePaths?.length) {
        await Promise.allSettled(
          captureData.imagePaths.map((path) => deleteObject(ref(storage, path))),
        );
      }

      // Delete capture document
      await deleteDoc(doc(db, "captures", captureId));
    } catch (err) {
      console.error("Delete error:", err);
      alert("Failed to delete capture. Please try again.");
    } finally {
      setDeletingCaptureId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-zinc-600">
            Quick stats and your latest captures.
          </p>
        </div>

        <Link
          href="/companion"
          className="inline-flex items-center justify-center rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-800"
          aria-label="Go to Quick Capture"
        >
          Quick Capture
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-zinc-200 bg-white p-4">
          <div className="text-sm text-zinc-600">Contacts</div>
          <div className="mt-2 text-3xl font-semibold tracking-tight">
            {stats.contactsCount ?? "—"}
          </div>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-white p-4">
          <div className="text-sm text-zinc-600">Captures</div>
          <div className="mt-2 text-3xl font-semibold tracking-tight">
            {stats.recentCapturesCount ?? "—"}
          </div>
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-white p-4">
          <div className="text-sm text-zinc-600">Actual revenue (Converted)</div>
          <div className="mt-2 text-2xl font-semibold tracking-tight">
            {revenueIsLoading ? "…" : revenue?.actual.lines.length === 1 ? formatMoney(revenue.actual.lines[0]!.total, revenue.actual.lines[0]!.currency) : revenue?.actual.lines.length ? "Multiple" : "—"}
          </div>
          <div className="mt-2 text-xs text-zinc-600">
            {revenueError
              ? revenueError
              : revenue?.actual.lines.length
                ? `${revenue.actual.pricedItems} priced items across ${revenue.actual.contactsWithItems} contacts`
                : "Add amounts to converted sales to see totals"}
          </div>
          {revenue?.actual.lines.length && revenue.actual.lines.length > 1 ? (
            <div className="mt-2 space-y-1 text-xs text-zinc-700">
              {revenue.actual.lines.slice(0, 3).map((l) => (
                <div key={`a:${l.currency}`} className="flex items-center justify-between gap-2">
                  <div className="truncate">{l.currency}</div>
                  <div className="shrink-0 font-medium">{formatMoney(l.total, l.currency)}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-white p-4">
          <div className="text-sm text-zinc-600">Potential revenue (Warm/Hot)</div>
          <div className="mt-2 text-2xl font-semibold tracking-tight">
            {revenueIsLoading ? "…" : revenue?.potential.lines.length === 1 ? formatMoney(revenue.potential.lines[0]!.total, revenue.potential.lines[0]!.currency) : revenue?.potential.lines.length ? "Multiple" : "—"}
          </div>
          <div className="mt-2 text-xs text-zinc-600">
            {revenueError
              ? revenueError
              : revenue?.potential.lines.length
                ? `${revenue.potential.pricedItems} priced items across ${revenue.potential.contactsWithItems} contacts`
                : "Add amounts to possible purchases to see totals"}
          </div>
          {revenue?.potential.lines.length && revenue.potential.lines.length > 1 ? (
            <div className="mt-2 space-y-1 text-xs text-zinc-700">
              {revenue.potential.lines.slice(0, 3).map((l) => (
                <div key={`p:${l.currency}`} className="flex items-center justify-between gap-2">
                  <div className="truncate">{l.currency}</div>
                  <div className="shrink-0 font-medium">{formatMoney(l.total, l.currency)}</div>
                </div>
              ))}
            </div>
          ) : null}
          {revenue?.isTruncated ? (
            <div className="mt-2 text-[11px] text-zinc-500">
              Scanned first {MAX_CONTACTS_FOR_REVENUE} contacts for revenue.
            </div>
          ) : null}
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white">
        <div className="border-b border-zinc-200 px-4 py-3">
          <h2 className="text-sm font-medium text-zinc-900">Recent captures</h2>
        </div>
        <div className="divide-y divide-zinc-200">
          {recentCaptures.length ? (
            recentCaptures.map(({ id, data, contactName, linkUrl, linkLabel }) => {
              const displayTitle = contactName || data.text?.trim() || "Untitled capture";
              const isDeleting = deletingCaptureId === id;
              
              return (
                <div key={id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-zinc-900">
                      {displayTitle}
                    </div>
                    <div className="mt-1 text-xs text-zinc-600">
                      Status: <span className="font-medium">{data.status}</span>
                      {data.imagePaths?.length ? ` · ${data.imagePaths.length} images` : ""}
                      {contactName && data.text?.trim() && (
                        <span className="ml-2 text-zinc-400">
                          · {data.text.trim().substring(0, 30)}
                          {data.text.trim().length > 30 ? "..." : ""}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {(data.status === "queued" || data.status === "error") && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleDeleteCapture(id, data);
                        }}
                        disabled={isDeleting}
                        className="rounded-lg border border-red-200 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                        aria-label="Delete capture"
                      >
                        {isDeleting ? "Deleting…" : "Delete"}
                      </button>
                    )}
                    <Link
                      href={linkUrl}
                      className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-900 hover:bg-zinc-100"
                      aria-label={`Open ${contactName ? "contact" : "capture"} ${id}`}
                    >
                      {linkLabel}
                    </Link>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="px-4 py-10 text-center text-sm text-zinc-600">
              No captures yet. Try{" "}
              <Link href="/companion" className="font-medium text-zinc-900 underline">
                Quick Capture
              </Link>
              .
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


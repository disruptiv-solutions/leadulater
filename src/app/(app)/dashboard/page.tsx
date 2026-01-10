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
import type { CaptureDoc, ContactDoc } from "@/lib/types";

type DashboardStats = {
  contactsCount: number | null;
  recentCapturesCount: number | null;
};

type CaptureWithContact = {
  id: string;
  data: CaptureDoc;
  contactName: string | null;
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
    if (!capturesQuery || !ownerId) return;

    const applySnapshot = async (snapshot: any) => {
      const captures: Array<{ id: string; data: CaptureDoc }> = snapshot.docs.map((d: any) => ({
        id: d.id,
        data: d.data() as CaptureDoc,
      }));

      // Fetch contact names for captures that have resultContactId
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
                return { ...capture, contactName: getContactDisplayName(contactData) };
              }
            } catch (err) {
              console.error("Error fetching contact:", err);
            }
          }
          return { ...capture, contactName: null };
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

      <div className="grid gap-3 sm:grid-cols-2">
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
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white">
        <div className="border-b border-zinc-200 px-4 py-3">
          <h2 className="text-sm font-medium text-zinc-900">Recent captures</h2>
        </div>
        <div className="divide-y divide-zinc-200">
          {recentCaptures.length ? (
            recentCaptures.map(({ id, data, contactName }) => {
              const displayTitle = contactName || data.text?.trim() || "Untitled capture";
              const linkUrl = data.resultContactId 
                ? `/contacts/${data.resultContactId}` 
                : `/companion/captures/${id}`;
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
                      {contactName ? "View Contact" : "View"}
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


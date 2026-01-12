"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, serverTimestamp, updateDoc, where, writeBatch } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { db } from "@/lib/firebase/firestore";
import { useAuth } from "@/lib/hooks/useAuth";
import { useCrm } from "@/lib/hooks/useCrm";
import type { ContactDoc } from "@/lib/types";
import { getDownloadURL, ref } from "firebase/storage";
import { storage } from "@/lib/firebase/storage";
import Image from "next/image";

type ContactRow = {
  id: string;
  data: ContactDoc;
};

type FilterType = "all" | "leads" | "customers";
type LeadStatus = "not_sure" | "cold" | "warm" | "hot" | "customer";

const VALID_LEAD_STATUSES = ["not_sure", "cold", "warm", "hot", "customer"] as const;
const coerceLeadStatus = (value: unknown): LeadStatus => {
  if (VALID_LEAD_STATUSES.includes(value as LeadStatus)) return value as LeadStatus;
  return "not_sure";
};

const displayName = (c: ContactDoc): string => {
  const name = c.fullName?.trim();
  if (name) return name;
  const parts = [c.firstName?.trim(), c.lastName?.trim()].filter(Boolean);
  if (parts.length) return parts.join(" ");
  return "Unnamed contact";
};

const leadStatusLabel = (v: LeadStatus | undefined): string => {
  switch (v) {
    case "cold":
      return "Cold";
    case "warm":
      return "Warm";
    case "hot":
      return "Hot";
    case "customer":
      return "Converted";
    default:
      return "Not sure";
  }
};

const leadStatusRowClass = (v: LeadStatus): string => {
  switch (v) {
    case "hot":
      return "bg-red-50";
    case "warm":
      return "bg-amber-50";
    case "cold":
      return "bg-sky-50";
    case "customer":
      return "bg-emerald-50";
    default:
      return "bg-white";
  }
};

const leadStatusSelectClass = (v: LeadStatus): string => {
  switch (v) {
    case "hot":
      return "border-red-200 bg-red-50 text-red-900";
    case "warm":
      return "border-amber-200 bg-amber-50 text-amber-900";
    case "cold":
      return "border-sky-200 bg-sky-50 text-sky-900";
    case "customer":
      return "border-emerald-200 bg-emerald-50 text-emerald-900";
    default:
      return "border-zinc-200 bg-white text-zinc-900";
  }
};

type RevenueBadge = { kind: "converted" | "potential"; label: string };

const computeRevenueBadge = (c: ContactDoc): RevenueBadge | null => {
  const purchases = (c as any)?.purchases;
  if (!Array.isArray(purchases)) return null;

  let converted = 0;
  let potential = 0;

  for (const raw of purchases) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as any;
    const amount = p?.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) continue;

    const stage = `${p?.stage ?? ""}`.trim();
    if (stage === "converted") converted += amount;
    if (stage === "possible") potential += amount;
  }

  const fmt = (n: number) => {
    try {
      return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
    } catch {
      return `${n}`;
    }
  };

  if (converted > 0) return { kind: "converted", label: fmt(converted) };
  if (potential > 0) return { kind: "potential", label: fmt(potential) };
  return null;
};

const avatarLetter = (c: ContactDoc): string => {
  const base =
    c.fullName?.trim() ||
    [c.firstName?.trim(), c.lastName?.trim()].filter(Boolean).join(" ").trim() ||
    c.email?.trim() ||
    "C";
  return (base[0] || "C").toUpperCase();
};

export default function ContactsPage() {
  const { user } = useAuth();
  const ownerId = user?.uid ?? null;
  const { activeScope, activeCrmId } = useCrm();

  const [rows, setRows] = useState<ContactRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<FilterType>("all");
  const [searchText, setSearchText] = useState<string>("");
  const [deletingContactId, setDeletingContactId] = useState<string | null>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string>("");
  const [avatarUrlByPath, setAvatarUrlByPath] = useState<Record<string, string>>({});
  const [selectedIds, setSelectedIds] = useState<Record<string, true>>({});
  const [showBulkDeleteModal, setShowBulkDeleteModal] = useState(false);
  const [showBulkEditModal, setShowBulkEditModal] = useState(false);
  const [isBulkWorking, setIsBulkWorking] = useState(false);

  // Bulk edit state (apply toggles + values)
  const [bulkApplyIsDraft, setBulkApplyIsDraft] = useState(false);
  const [bulkIsDraft, setBulkIsDraft] = useState<boolean>(false);
  const [bulkApplyCompany, setBulkApplyCompany] = useState(false);
  const [bulkCompanyName, setBulkCompanyName] = useState<string>("");
  const [bulkApplyJobTitle, setBulkApplyJobTitle] = useState(false);
  const [bulkJobTitle, setBulkJobTitle] = useState<string>("");
  const [bulkApplyTags, setBulkApplyTags] = useState(false);
  const [bulkTagsCsv, setBulkTagsCsv] = useState<string>("");

  const contactsQuery = useMemo(() => {
    if (!ownerId) return null;
    
    // Always use memberIds for security rules compatibility
    // If we're in CRM scope, we'll also filter by crmId
    const baseConstraints =
      activeScope === "crm" && activeCrmId
        ? [where("memberIds", "array-contains", ownerId), where("crmId", "==", activeCrmId)]
        : [where("memberIds", "array-contains", ownerId)];

    let q = query(
      collection(db, "contacts"),
      ...baseConstraints,
      orderBy("updatedAt", "desc"),
      limit(200),
    );

    // Apply filter
    if (filter === "leads") {
      q = query(
        collection(db, "contacts"),
        ...baseConstraints,
        where("isDraft", "==", true),
        orderBy("updatedAt", "desc"),
        limit(200),
      );
    } else if (filter === "customers") {
      q = query(
        collection(db, "contacts"),
        ...baseConstraints,
        where("isDraft", "==", false),
        orderBy("updatedAt", "desc"),
        limit(200),
      );
    }

    return q;
  }, [activeCrmId, activeScope, ownerId, filter]);

  useEffect(() => {
    if (!contactsQuery || !ownerId) return;
    
    const unsubscribe = onSnapshot(
      contactsQuery,
      (snapshot) => {
        setIsLoading(false);
        const nextRows = snapshot.docs.map((d) => ({ id: d.id, data: d.data() as ContactDoc }));
        setRows(nextRows);
        // Keep selection only for currently-visible rows.
        const visible = new Set(nextRows.map((r) => r.id));
        setSelectedIds((prev) => {
          const next: Record<string, true> = {};
          for (const id of Object.keys(prev)) {
            if (visible.has(id)) next[id] = true;
          }
          return next;
        });
      },
      (error) => {
        console.error("Contacts query error:", error);
        setIsLoading(false);
        setRows([]);
        setSelectedIds({});
        
        // If you see a permission-denied error, click "Fix data" in the CRM dropdown menu
        if ((error as any)?.code === "permission-denied") {
          console.error("Permission denied: Your contacts don't have you in their memberIds arrays.");
          console.error("SOLUTION: Click the 'Fix data' button in the CRM dropdown menu.");
        }
      },
    );
    
    return () => {
      unsubscribe();
    };
  }, [contactsQuery, ownerId]);

  // Resolve avatar URLs for currently-visible rows (best-effort, cached)
  useEffect(() => {
    const paths = Array.from(
      new Set(
        rows
          .map((r) => r.data.profileImagePath)
          .filter((p): p is string => typeof p === "string" && p.trim().length > 0),
      ),
    );
    const missing = paths.filter((p) => !avatarUrlByPath[p]);
    if (missing.length === 0) return;
    let cancelled = false;
    const run = async () => {
      const pairs = await Promise.all(
        missing.slice(0, 50).map(async (p) => {
          try {
            const url = await getDownloadURL(ref(storage, p));
            const busted = url.includes("?") ? `${url}&t=${Date.now()}` : `${url}?t=${Date.now()}`;
            return [p, busted] as const;
          } catch {
            return [p, ""] as const;
          }
        }),
      );
      if (cancelled) return;
      setAvatarUrlByPath((prev) => {
        const next = { ...prev };
        for (const [p, url] of pairs) {
          if (url) next[p] = url;
        }
        return next;
      });
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [avatarUrlByPath, rows]);

  const normalizedSearch = useMemo(() => searchText.trim().toLowerCase(), [searchText]);

  const visibleRows = useMemo(() => {
    if (!normalizedSearch) return rows;
    return rows.filter(({ data }) => {
      const haystack = [
        displayName(data),
        data.companyName ?? "",
        data.email ?? "",
        data.phone ?? "",
        data.jobTitle ?? "",
        data.website ?? "",
        data.linkedInUrl ?? "",
        ...(Array.isArray(data.tags) ? data.tags : []),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [normalizedSearch, rows]);

  // Keep selection only for currently visible rows (avoid bulk actions on hidden rows when searching).
  useEffect(() => {
    const visible = new Set(visibleRows.map((r) => r.id));
    setSelectedIds((prev) => {
      const next: Record<string, true> = {};
      for (const id of Object.keys(prev)) {
        if (visible.has(id)) next[id] = true;
      }
      return next;
    });
  }, [visibleRows]);

  const filteredCount = rows.length;
  const visibleCount = visibleRows.length;
  const selectedCount = Object.keys(selectedIds).length;
  const allSelectedOnPage = visibleRows.length > 0 && selectedCount === visibleRows.length;

  const toggleSelectAllOnPage = () => {
    if (visibleRows.length === 0) return;
    if (allSelectedOnPage) {
      setSelectedIds({});
      return;
    }
    const next: Record<string, true> = {};
    for (const r of visibleRows) next[r.id] = true;
    setSelectedIds(next);
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      if (prev[id]) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: true };
    });
  };

  const handleDeleteContact = async (contactId: string, contactData: ContactDoc) => {
    if (!ownerId) return;
    const canDelete = contactData.ownerId === ownerId || contactData.memberIds?.includes(ownerId);
    if (!canDelete) return;
    const contactName = displayName(contactData);
    if (!confirm(`Are you sure you want to delete ${contactName}? This cannot be undone.`)) return;

    setDeletingContactId(contactId);
    try {
      await deleteDoc(doc(db, "contacts", contactId));
    } catch (err) {
      console.error("Delete error:", err);
      alert("Failed to delete contact. Please try again.");
      setDeletingContactId(null);
    }
  };

  const handleQuickStatusChange = async (contactId: string, next: LeadStatus, prev: LeadStatus) => {
    // Optimistic UI update
    setRows((current) =>
      current.map((r) =>
        r.id === contactId ? { ...r, data: { ...r.data, leadStatus: next } } : r,
      ),
    );

    try {
      await updateDoc(doc(db, "contacts", contactId), {
        leadStatus: next,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.error("Failed to update lead status:", err);
      // Revert
      setRows((current) =>
        current.map((r) =>
          r.id === contactId ? { ...r, data: { ...r.data, leadStatus: prev } } : r,
        ),
      );
      alert("Failed to update status. Please try again.");
    }
  };

  const handleUploadContacts = async () => {
    if (!uploadFile || !ownerId || !activeCrmId) {
      alert("Please select a CSV file and ensure you have an active CRM selected.");
      return;
    }

    setIsUploading(true);
    setUploadProgress("Reading file...");

    try {
      // Read the CSV file
      const text = await uploadFile.text();
      
      setUploadProgress("Processing with AI...");

      // Send to API for processing
      const response = await fetch("/api/contacts/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csvContent: text,
          ownerId,
          crmId: activeCrmId,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(error.error || "Upload failed");
      }

      const result = await response.json();

      const debug = [
        typeof result?.rowsParsed === "number" ? `Rows parsed: ${result.rowsParsed}` : null,
        typeof result?.count === "number" ? `Contacts created: ${result.count}` : null,
        typeof result?.usedAiMapping === "boolean" ? `AI mapping: ${result.usedAiMapping ? "on" : "fallback"}` : null,
      ]
        .filter(Boolean)
        .join(" • ");

      setUploadProgress(
        typeof result?.count === "number"
          ? `Upload complete. ${debug}`
          : "Upload complete.",
      );
      
      // Close modal after a short delay
      setTimeout(() => {
        setShowUploadModal(false);
        setUploadFile(null);
        setUploadProgress("");
      }, 2000);
      
    } catch (err) {
      console.error("Upload error:", err);
      alert(err instanceof Error ? err.message : "Failed to upload contacts");
      setUploadProgress("");
    } finally {
      setIsUploading(false);
    }
  };

  const resetBulkEditState = () => {
    setBulkApplyIsDraft(false);
    setBulkIsDraft(false);
    setBulkApplyCompany(false);
    setBulkCompanyName("");
    setBulkApplyJobTitle(false);
    setBulkJobTitle("");
    setBulkApplyTags(false);
    setBulkTagsCsv("");
  };

  const handleBulkDelete = async () => {
    if (!ownerId) return;
    const ids = Object.keys(selectedIds);
    if (ids.length === 0) return;

    setIsBulkWorking(true);
    try {
      const batch = writeBatch(db);
      for (const id of ids) {
        batch.delete(doc(db, "contacts", id));
      }
      await batch.commit();
      setSelectedIds({});
      setShowBulkDeleteModal(false);
    } catch (err) {
      console.error("Bulk delete error:", err);
      alert("Failed to delete selected contacts. Please try again.");
    } finally {
      setIsBulkWorking(false);
    }
  };

  const handleBulkEdit = async () => {
    if (!ownerId) return;
    const ids = Object.keys(selectedIds);
    if (ids.length === 0) return;

    const update: Partial<ContactDoc> & Record<string, unknown> = {};
    if (bulkApplyIsDraft) update.isDraft = bulkIsDraft;
    if (bulkApplyCompany) update.companyName = bulkCompanyName.trim() || "";
    if (bulkApplyJobTitle) update.jobTitle = bulkJobTitle.trim() || "";
    if (bulkApplyTags) {
      const tags = bulkTagsCsv
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      update.tags = Array.from(new Set(tags));
    }

    if (Object.keys(update).length === 0) {
      alert("Choose at least one field to update.");
      return;
    }

    update.updatedAt = serverTimestamp();

    setIsBulkWorking(true);
    try {
      const batch = writeBatch(db);
      for (const id of ids) {
        batch.update(doc(db, "contacts", id), update);
      }
      await batch.commit();
      setShowBulkEditModal(false);
      resetBulkEditState();
      setSelectedIds({});
    } catch (err) {
      console.error("Bulk edit error:", err);
      alert("Failed to update selected contacts. Please try again.");
    } finally {
      setIsBulkWorking(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
          <p className="mt-1 text-sm text-zinc-600">
            {filter === "all" &&
              `${visibleCount}${normalizedSearch ? ` match${visibleCount !== 1 ? "es" : ""} of ${filteredCount}` : " total"}`}
            {filter === "leads" &&
              `${visibleCount}${normalizedSearch ? ` match${visibleCount !== 1 ? "es" : ""} of ${filteredCount}` : ` lead${filteredCount !== 1 ? "s" : ""}`}`}
            {filter === "customers" &&
              `${visibleCount}${normalizedSearch ? ` match${visibleCount !== 1 ? "es" : ""} of ${filteredCount}` : ` customer${filteredCount !== 1 ? "s" : ""}`}`}
            {filteredCount >= 200 && " (showing first 200)"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {activeCrmId && (
            <button
              type="button"
              onClick={() => setShowUploadModal(true)}
              className="inline-flex items-center justify-center rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
            >
              Upload Contacts
            </button>
          )}
          <Link
            href="/companion"
            className="inline-flex items-center justify-center rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-800"
            aria-label="Create a new capture"
          >
            New capture
          </Link>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-2 border-b border-zinc-200">
        <button
          type="button"
          onClick={() => setFilter("all")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            filter === "all"
              ? "border-b-2 border-zinc-900 text-zinc-900"
              : "text-zinc-600 hover:text-zinc-900"
          }`}
          aria-label="Show all contacts"
        >
          All
        </button>
        <button
          type="button"
          onClick={() => setFilter("leads")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            filter === "leads"
              ? "border-b-2 border-zinc-900 text-zinc-900"
              : "text-zinc-600 hover:text-zinc-900"
          }`}
          aria-label="Show leads only"
        >
          Leads
        </button>
        <button
          type="button"
          onClick={() => setFilter("customers")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            filter === "customers"
              ? "border-b-2 border-zinc-900 text-zinc-900"
              : "text-zinc-600 hover:text-zinc-900"
          }`}
          aria-label="Show customers only"
        >
          Customers
        </button>
      </div>

      {/* Search */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex-1">
          <label className="sr-only" htmlFor="contacts-search">
            Search contacts
          </label>
          <input
            id="contacts-search"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400"
            placeholder="Search by name, company, email, tags…"
            aria-label="Search contacts"
          />
        </div>
        {normalizedSearch ? (
          <button
            type="button"
            onClick={() => setSearchText("")}
            className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-100"
            aria-label="Clear search"
          >
            Clear
          </button>
        ) : null}
      </div>

      {/* Bulk actions */}
      {selectedCount > 0 && (
        <div className="flex flex-col gap-2 rounded-2xl border border-zinc-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={allSelectedOnPage}
                onChange={toggleSelectAllOnPage}
                className="h-4 w-4 rounded border-zinc-300 text-zinc-900"
              />
              <span className="text-zinc-900">
                {allSelectedOnPage ? "All selected (this page)" : "Select all (this page)"}
              </span>
            </label>
            <span className="text-zinc-600">{selectedCount} selected</span>
            <button
              type="button"
              onClick={() => setSelectedIds({})}
              className="rounded-lg px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-100"
            >
              Clear
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowBulkEditModal(true)}
              className="rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
              disabled={isBulkWorking}
            >
              Edit selected
            </button>
            <button
              type="button"
              onClick={() => setShowBulkDeleteModal(true)}
              className="rounded-xl bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              disabled={isBulkWorking}
            >
              Delete selected
            </button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
        <div className="grid grid-cols-12 gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-xs font-medium text-zinc-600">
          <div className="col-span-1">
            <input
              type="checkbox"
              checked={allSelectedOnPage}
              onChange={toggleSelectAllOnPage}
              className="h-4 w-4 rounded border-zinc-300 text-zinc-900"
              aria-label="Select all contacts on this page"
            />
          </div>
          <div className="col-span-3">Name</div>
          <div className="col-span-3">Company</div>
          <div className="col-span-2">Email</div>
          <div className="col-span-1 text-right">Revenue</div>
          <div className="col-span-2 text-right">Status</div>
        </div>

        {isLoading ? (
          <div className="px-4 py-10 text-center text-sm text-zinc-600">Loading…</div>
        ) : visibleRows.length ? (
          <div className="divide-y divide-zinc-200">
            {visibleRows.map(({ id, data }) => {
              const isDeleting = deletingContactId === id;
              // Firestore may contain legacy/unexpected strings; coerce safely for the UI.
              const status = coerceLeadStatus((data as unknown as { leadStatus?: unknown }).leadStatus);
              const revenue = computeRevenueBadge(data);
              const avatarPath = data.profileImagePath?.trim() || null;
              const avatarUrl = avatarPath ? avatarUrlByPath[avatarPath] : undefined;
              return (
                <div
                  key={id}
                  className={[
                    "grid grid-cols-12 gap-3 px-4 py-3 text-sm hover:bg-zinc-50",
                    leadStatusRowClass(status),
                  ].join(" ")}
                >
                  <div className="col-span-1 flex items-center">
                    <input
                      type="checkbox"
                      checked={!!selectedIds[id]}
                      onChange={() => toggleSelected(id)}
                      className="h-4 w-4 rounded border-zinc-300 text-zinc-900"
                      aria-label={`Select contact ${displayName(data)}`}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                  <Link
                    href={`/contacts/${id}`}
                    className="col-span-3 truncate font-medium text-zinc-900 hover:text-zinc-600 transition-colors"
                    aria-label={`Open contact ${displayName(data)}`}
                  >
                    <span className="inline-flex items-center gap-2">
                      <span className="relative h-8 w-8 overflow-hidden rounded-full border border-zinc-200 bg-zinc-100 text-xs font-semibold text-zinc-700">
                        {avatarUrl ? (
                          <Image src={avatarUrl} alt="" fill sizes="32px" className="object-cover" />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center">
                            {avatarLetter(data)}
                          </span>
                        )}
                      </span>
                      <span className="truncate">{displayName(data)}</span>
                    </span>
                  </Link>
                  <Link
                    href={`/contacts/${id}`}
                    className="col-span-3 truncate text-zinc-700"
                  >
                    {data.companyName?.trim() || "—"}
                  </Link>
                  <Link
                    href={`/contacts/${id}`}
                    className="col-span-2 truncate text-zinc-700"
                  >
                    {data.email?.trim() || "—"}
                  </Link>
                  <div className="col-span-1 flex items-center justify-end">
                    {revenue ? (
                      <span
                        className={[
                          "inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold",
                          revenue.kind === "converted"
                            ? "bg-emerald-100 text-emerald-900"
                            : "bg-sky-100 text-sky-900",
                        ].join(" ")}
                        aria-label={
                          revenue.kind === "converted"
                            ? `Converted revenue ${revenue.label}`
                            : `Potential revenue ${revenue.label}`
                        }
                        title={revenue.kind === "converted" ? "Converted revenue" : "Potential revenue"}
                      >
                        {revenue.label}
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-400">—</span>
                    )}
                  </div>
                  <div className="col-span-2 flex items-center justify-end gap-2">
                    <select
                      value={status}
                      onChange={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const prev = status;
                        const next = e.target.value as LeadStatus;
                        void handleQuickStatusChange(id, next, prev);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className={[
                        "max-w-[140px] rounded-lg px-2 py-1 text-xs hover:bg-zinc-50",
                        leadStatusSelectClass(status),
                      ].join(" ")}
                      aria-label={`Change status for ${displayName(data)} (currently ${leadStatusLabel(status)})`}
                    >
                      <option value="not_sure">Not sure</option>
                      <option value="cold">Cold</option>
                      <option value="warm">Warm</option>
                      <option value="hot">Hot</option>
                      <option value="customer">Converted</option>
                    </select>
                    {data.isDraft ? (
                      <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                        Draft
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleDeleteContact(id, data);
                      }}
                      disabled={isDeleting}
                      className="rounded-lg border border-red-200 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                      aria-label={`Delete contact ${displayName(data)}`}
                    >
                      {isDeleting ? "…" : "×"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="px-4 py-10 text-center text-sm text-zinc-600">
            {normalizedSearch ? (
              <>
                No matches for <span className="font-medium">“{searchText.trim()}”</span>.{" "}
                <button
                  type="button"
                  onClick={() => setSearchText("")}
                  className="font-medium text-zinc-900 underline"
                  aria-label="Clear search"
                >
                  Clear search
                </button>
                .
              </>
            ) : (
              <>
                No contacts yet. Start with{" "}
                <Link href="/companion" className="font-medium text-zinc-900 underline">
                  Quick Capture
                </Link>
                .
              </>
            )}
          </div>
        )}
      </div>

      {/* Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="text-xl font-semibold">Upload Contacts</h2>
            <p className="mt-2 text-sm text-zinc-600">
              Upload a CSV file with contact information. Our AI will automatically map the fields to your contacts.
            </p>
            <div className="mt-3 rounded-lg bg-blue-50 p-3 text-xs text-blue-900">
              <p className="font-medium">Supported fields:</p>
              <p className="mt-1">Name, Email, Phone, Company, Title, Website, Address, City, State, Zip, Country, Notes</p>
              <p className="mt-2 text-blue-700">The AI will detect your column names automatically!</p>
              <p className="mt-2 text-blue-600">Max file size: 500KB</p>
            </div>

            <div className="mt-6">
              <label className="block">
                <span className="text-sm font-medium text-zinc-700">CSV File</span>
                <input
                  type="file"
                  accept=".csv"
                  onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                  disabled={isUploading}
                  className="mt-2 block w-full text-sm text-zinc-600 file:mr-4 file:rounded-lg file:border-0 file:bg-zinc-100 file:px-4 file:py-2 file:text-sm file:font-medium file:text-zinc-900 hover:file:bg-zinc-200 disabled:opacity-50"
                />
              </label>
              {uploadFile && (
                <p className="mt-2 text-xs text-zinc-500">
                  Selected: {uploadFile.name} ({(uploadFile.size / 1024).toFixed(1)} KB)
                </p>
              )}
            </div>

            {uploadProgress && (
              <div className="mt-4 rounded-lg bg-blue-50 p-3 text-sm text-blue-900">
                {uploadProgress}
              </div>
            )}

            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowUploadModal(false);
                  setUploadFile(null);
                  setUploadProgress("");
                }}
                disabled={isUploading}
                className="rounded-xl px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleUploadContacts}
                disabled={!uploadFile || isUploading}
                className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                {isUploading ? "Uploading..." : "Upload"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Delete Modal */}
      {showBulkDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="text-xl font-semibold text-zinc-900">Delete contacts</h2>
            <p className="mt-2 text-sm text-zinc-600">
              Are you sure you want to delete <span className="font-medium">{selectedCount}</span>{" "}
              contact{selectedCount === 1 ? "" : "s"}? This cannot be undone.
            </p>

            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowBulkDeleteModal(false)}
                disabled={isBulkWorking}
                className="rounded-xl px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleBulkDelete}
                disabled={isBulkWorking}
                className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {isBulkWorking ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Edit Modal */}
      {showBulkEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="text-xl font-semibold text-zinc-900">Edit selected contacts</h2>
            <p className="mt-2 text-sm text-zinc-600">
              Apply changes to <span className="font-medium">{selectedCount}</span> selected contact
              {selectedCount === 1 ? "" : "s"}.
            </p>

            <div className="mt-6 space-y-4">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={bulkApplyIsDraft}
                  onChange={(e) => setBulkApplyIsDraft(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-zinc-300 text-zinc-900"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-zinc-900">Status</div>
                  <select
                    value={bulkIsDraft ? "draft" : "saved"}
                    onChange={(e) => setBulkIsDraft(e.target.value === "draft")}
                    disabled={!bulkApplyIsDraft}
                    className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm disabled:opacity-50"
                  >
                    <option value="draft">Draft</option>
                    <option value="saved">Saved</option>
                  </select>
                </div>
              </label>

              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={bulkApplyCompany}
                  onChange={(e) => setBulkApplyCompany(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-zinc-300 text-zinc-900"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-zinc-900">Company</div>
                  <input
                    value={bulkCompanyName}
                    onChange={(e) => setBulkCompanyName(e.target.value)}
                    disabled={!bulkApplyCompany}
                    placeholder="Set company name (empty will clear)"
                    className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm disabled:opacity-50"
                  />
                </div>
              </label>

              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={bulkApplyJobTitle}
                  onChange={(e) => setBulkApplyJobTitle(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-zinc-300 text-zinc-900"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-zinc-900">Job title</div>
                  <input
                    value={bulkJobTitle}
                    onChange={(e) => setBulkJobTitle(e.target.value)}
                    disabled={!bulkApplyJobTitle}
                    placeholder="Set job title (empty will clear)"
                    className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm disabled:opacity-50"
                  />
                </div>
              </label>

              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={bulkApplyTags}
                  onChange={(e) => setBulkApplyTags(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-zinc-300 text-zinc-900"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-zinc-900">Tags</div>
                  <input
                    value={bulkTagsCsv}
                    onChange={(e) => setBulkTagsCsv(e.target.value)}
                    disabled={!bulkApplyTags}
                    placeholder="Comma-separated tags (replaces existing)"
                    className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm disabled:opacity-50"
                  />
                </div>
              </label>
            </div>

            <div className="mt-6 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowBulkEditModal(false);
                  resetBulkEditState();
                }}
                disabled={isBulkWorking}
                className="rounded-xl px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={resetBulkEditState}
                  disabled={isBulkWorking}
                  className="rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-50"
                >
                  Reset
                </button>
                <button
                  type="button"
                  onClick={handleBulkEdit}
                  disabled={isBulkWorking}
                  className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                >
                  {isBulkWorking ? "Saving..." : "Save changes"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


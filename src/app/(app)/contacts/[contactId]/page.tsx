"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  documentId,
  limit,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  where,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { db, nowServerTimestamp } from "@/lib/firebase/firestore";
import { storage } from "@/lib/firebase/storage";
import { useAuth } from "@/lib/hooks/useAuth";
import type { ContactDoc, ContactPurchase, NoteDoc, PurchaseCadence, PurchaseStage } from "@/lib/types";
import type { SocialFollower, SocialFollowerMetric, SocialPlatform } from "@/lib/types";
import { getIdToken } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase/auth";

type NavTab = "contact" | "research" | "notes";

type LocalImage = {
  id: string;
  file: File;
  previewUrl: string;
};

const toLocalImage = (file: File): LocalImage => ({
  id: crypto.randomUUID(),
  file,
  previewUrl: URL.createObjectURL(file),
});

const isImageFile = (file: File) => file.type.startsWith("image/");

type ResearchHeading = {
  level: number; // 1-6
  text: string;
  id: string;
};

type ContactFormState = {
  fullName: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  companyName: string;
  email: string;
  phone: string;
  linkedInUrl: string;
  website: string;
  location: string;
  leadStatus: "not_sure" | "cold" | "warm" | "hot" | "customer";
  summary: string;
  tagsCsv: string;
};

const VALID_LEAD_STATUSES = ["not_sure", "cold", "warm", "hot", "customer"] as const;
type ValidLeadStatus = (typeof VALID_LEAD_STATUSES)[number];

const coerceLeadStatus = (value: unknown): ValidLeadStatus => {
  if (VALID_LEAD_STATUSES.includes(value as ValidLeadStatus)) return value as ValidLeadStatus;
  return "not_sure";
};

const toFormState = (c: ContactDoc): ContactFormState => ({
  fullName: c.fullName ?? "",
  firstName: c.firstName ?? "",
  lastName: c.lastName ?? "",
  jobTitle: c.jobTitle ?? "",
  companyName: c.companyName ?? "",
  email: c.email ?? "",
  phone: c.phone ?? "",
  linkedInUrl: c.linkedInUrl ?? "",
  website: c.website ?? "",
  location: c.location ?? "",
  // Firestore may contain legacy/unexpected strings; coerce safely for the UI.
  leadStatus: coerceLeadStatus((c as unknown as { leadStatus?: unknown }).leadStatus),
  summary: c.deepResearchSummary ?? c.notes ?? "",
  tagsCsv: (c.tags ?? []).join(", "),
});

const parseTags = (tagsCsv: string): string[] => {
  const unique = new Set(
    tagsCsv
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  );
  return Array.from(unique);
};

const platformLabel = (p: SocialPlatform): string => {
  if (p === "x" || p === "twitter") return "X";
  if (p === "linkedin") return "LinkedIn";
  if (p === "youtube") return "YouTube";
  if (p === "tiktok") return "TikTok";
  return `${p[0]?.toUpperCase() ?? ""}${p.slice(1)}`;
};

const formatCompact = (n: number): string => {
  try {
    return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
  } catch {
    return `${n}`;
  }
};

const PURCHASE_CADENCES = ["monthly", "yearly", "one_off"] as const satisfies readonly PurchaseCadence[];
const PURCHASE_STAGES = ["possible", "converted"] as const satisfies readonly PurchaseStage[];

const cadenceLabel = (c: PurchaseCadence): string => {
  if (c === "monthly") return "Monthly subscription";
  if (c === "yearly") return "Yearly subscription";
  return "One-off";
};

const stageLabel = (s: PurchaseStage): string => (s === "converted" ? "Converted sale" : "Possible purchase");

const normalizeCadence = (value: unknown): PurchaseCadence => {
  if (PURCHASE_CADENCES.includes(value as PurchaseCadence)) return value as PurchaseCadence;
  return "one_off";
};

const normalizeStage = (value: unknown): PurchaseStage => {
  if (PURCHASE_STAGES.includes(value as PurchaseStage)) return value as PurchaseStage;
  return "possible";
};

const normalizeContactPurchase = (raw: unknown): ContactPurchase | null => {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as any;

  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!id || !name) return null;

  const cadence = normalizeCadence(obj.cadence);
  const stage = normalizeStage(obj.stage);
  const amount = typeof obj.amount === "number" ? obj.amount : Number(`${obj.amount ?? ""}`);
  const currency = typeof obj.currency === "string" ? obj.currency.trim() : "";
  const notes = typeof obj.notes === "string" ? obj.notes.trim() : "";

  return {
    id,
    name,
    cadence,
    stage,
    ...(Number.isFinite(amount) && amount >= 0 ? { amount } : {}),
    ...(currency ? { currency } : {}),
    ...(notes ? { notes } : {}),
    ...(typeof obj.createdAtMs === "number" && Number.isFinite(obj.createdAtMs) ? { createdAtMs: obj.createdAtMs } : {}),
    ...(typeof obj.updatedAtMs === "number" && Number.isFinite(obj.updatedAtMs) ? { updatedAtMs: obj.updatedAtMs } : {}),
  };
};

type AudienceDraft = {
  platform: SocialPlatform;
  countInput: string;
  metric: SocialFollowerMetric;
  label: string;
  handle: string;
  url: string;
};

type PurchaseDraft = {
  cadence: PurchaseCadence;
  name: string;
  amountInput: string;
  currency: string;
  notes: string;
};

const parseCountInput = (raw: string): number | null => {
  const v = raw.trim().toLowerCase().replace(/,/g, "");
  if (!v) return null;
  const m = v.match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num < 0) return null;
  const suffix = (m[2] || "").toLowerCase();
  const mult = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
  return Math.round(num * mult);
};

const slugify = (value: string): string => {
  return value
    .toLowerCase()
    .trim()
    .replace(/[`*_~]/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
};

const extractHeadings = (markdown: string): ResearchHeading[] => {
  const out: ResearchHeading[] = [];
  const seen = new Map<string, number>();

  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const level = m[1]!.length;
    const text = m[2]!.trim();
    if (!text) continue;

    const base = slugify(text);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const id = count === 1 ? base : `${base}-${count}`;

    out.push({ level, text, id });
  }

  return out;
};

const getNodeText = (node: unknown): string => {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(getNodeText).join("");
  if (node && typeof node === "object" && "props" in (node as any)) {
    return getNodeText((node as any).props?.children);
  }
  return "";
};

export default function ContactDetailPage() {
  const router = useRouter();
  const params = useParams<{ contactId: string }>();
  const contactId = params.contactId;

  const { user } = useAuth();
  const ownerId = user?.uid ?? null;

  const contactDocRef = useMemo(() => doc(db, "contacts", contactId), [contactId]);

  const contactMemberQuery = useMemo(() => {
    if (!ownerId) return null;
    return query(
      collection(db, "contacts"),
      where("memberIds", "array-contains", ownerId),
      where(documentId(), "==", contactId),
      limit(1),
    );
  }, [contactId, ownerId]);


  const [contact, setContact] = useState<ContactDoc | null>(null);
  const [form, setForm] = useState<ContactFormState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isResearching, setIsResearching] = useState(false);
  const [lastContactSummary, setLastContactSummary] = useState<string>("");
  const [lastContactFormBaseline, setLastContactFormBaseline] = useState<ContactFormState | null>(null);
  const [researchImageUrls, setResearchImageUrls] = useState<Array<{ path: string; url: string | null }>>([]);
  const [researchStream, setResearchStream] = useState<string>("");
  const [researchReasoning, setResearchReasoning] = useState<string>("");
  const [researchStage, setResearchStage] = useState<string | null>(null);
  const [researchSources, setResearchSources] = useState<
    Array<{ title?: string; url?: string; date?: string }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [navTab, setNavTab] = useState<NavTab>("contact");
  const [researchNavOpen, setResearchNavOpen] = useState<boolean>(true);
  const [notes, setNotes] = useState<Array<{ id: string; data: NoteDoc }>>([]);
  const [newNoteContent, setNewNoteContent] = useState<string>("");
  const [isCreatingNote, setIsCreatingNote] = useState<boolean>(false);
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [showAddInfoModal, setShowAddInfoModal] = useState<boolean>(false);
  const [addInfoImages, setAddInfoImages] = useState<LocalImage[]>([]);
  const [addInfoText, setAddInfoText] = useState<string>("");
  const [addInfoEnableDeepResearch, setAddInfoEnableDeepResearch] = useState<boolean>(false);
  const [addInfoIsSubmitting, setAddInfoIsSubmitting] = useState<boolean>(false);
  const [addInfoStage, setAddInfoStage] = useState<string | null>(null);
  const [addInfoError, setAddInfoError] = useState<string | null>(null);
  const [addInfoConflicts, setAddInfoConflicts] = useState<
    Array<{ field: string; existing: string; incoming: string }>
  >([]);
  const [addInfoPendingForce, setAddInfoPendingForce] = useState<boolean>(false);
  const [showAudienceModal, setShowAudienceModal] = useState<boolean>(false);
  const [audienceDraft, setAudienceDraft] = useState<AudienceDraft>({
    platform: "x",
    countInput: "",
    metric: "followers",
    label: "",
    handle: "",
    url: "",
  });
  const [audienceEditingPlatform, setAudienceEditingPlatform] = useState<SocialPlatform | null>(null);
  const [audienceIsSaving, setAudienceIsSaving] = useState<boolean>(false);
  const [audienceError, setAudienceError] = useState<string | null>(null);
  const [showPurchaseModal, setShowPurchaseModal] = useState<boolean>(false);
  const [purchaseStage, setPurchaseStage] = useState<PurchaseStage>("possible");
  const [purchaseDraft, setPurchaseDraft] = useState<PurchaseDraft>({
    cadence: "monthly",
    name: "",
    amountInput: "",
    currency: "",
    notes: "",
  });
  const [purchaseEditingId, setPurchaseEditingId] = useState<string | null>(null);
  const [purchaseIsSaving, setPurchaseIsSaving] = useState<boolean>(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      addInfoImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    };
  }, [addInfoImages]);

  const sanitizeThink = (text: string): string => {
    // Remove <think> blocks if present in streamed content
    return text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>|<\/think>/g, "");
  };

  const getFollowers = (): SocialFollower[] => {
    const list = (contact as any)?.socialFollowers;
    return Array.isArray(list) ? (list as SocialFollower[]) : [];
  };

  const getPurchases = (): ContactPurchase[] => {
    const list = (contact as any)?.purchases;
    if (!Array.isArray(list)) return [];
    return list.map(normalizeContactPurchase).filter((p): p is ContactPurchase => Boolean(p));
  };

  const defaultPurchaseStageForLeadStatus = (status: ContactFormState["leadStatus"]): PurchaseStage => {
    return status === "customer" ? "converted" : "possible";
  };

  const resetAudienceDraft = (platform: SocialPlatform = "x") => {
    setAudienceDraft({
      platform,
      countInput: "",
      metric: platform === "youtube" ? "subscribers" : "followers",
      label: "",
      handle: "",
      url: "",
    });
  };

  const resetPurchaseDraft = (cadence: PurchaseCadence = "monthly") => {
    setPurchaseDraft({
      cadence,
      name: "",
      amountInput: "",
      currency: "",
      notes: "",
    });
  };

  const handleOpenAddAudience = () => {
    setAudienceError(null);
    setAudienceEditingPlatform(null);
    resetAudienceDraft("x");
    setShowAudienceModal(true);
  };

  const handleOpenAddPurchase = (stageOverride?: PurchaseStage) => {
    setPurchaseError(null);
    setPurchaseEditingId(null);
    setPurchaseStage(stageOverride ?? defaultPurchaseStageForLeadStatus(form?.leadStatus ?? "not_sure"));
    resetPurchaseDraft("monthly");
    setShowPurchaseModal(true);
  };

  const handleOpenEditAudience = (f: SocialFollower) => {
    setAudienceError(null);
    setAudienceEditingPlatform(f.platform);
    setAudienceDraft({
      platform: f.platform,
      countInput: `${f.count ?? ""}`,
      metric: (f.metric ?? (f.platform === "youtube" ? "subscribers" : "followers")) as SocialFollowerMetric,
      label: typeof f.label === "string" ? f.label : "",
      handle: typeof f.handle === "string" ? f.handle : "",
      url: typeof f.url === "string" ? f.url : "",
    });
    setShowAudienceModal(true);
  };

  const handleOpenEditPurchase = (p: ContactPurchase) => {
    setPurchaseError(null);
    setPurchaseEditingId(p.id);
    setPurchaseStage(p.stage);
    setPurchaseDraft({
      cadence: p.cadence,
      name: p.name ?? "",
      amountInput: typeof p.amount === "number" && Number.isFinite(p.amount) ? `${p.amount}` : "",
      currency: typeof p.currency === "string" ? p.currency : "",
      notes: typeof p.notes === "string" ? p.notes : "",
    });
    setShowPurchaseModal(true);
  };

  const handleDeleteAudience = async (platform: SocialPlatform) => {
    if (!contact || !ownerId) return;
    const canEdit = contact.ownerId === ownerId || contact.memberIds?.includes(ownerId);
    if (!canEdit) return;

    setAudienceError(null);
    setAudienceIsSaving(true);
    try {
      const next = getFollowers().filter((f) => f?.platform !== platform);
      await updateDoc(contactDocRef, {
        socialFollowers: next,
        updatedAt: nowServerTimestamp(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to remove audience entry";
      setAudienceError(message);
    } finally {
      setAudienceIsSaving(false);
    }
  };

  const handleSaveAudience = async () => {
    if (!contact || !ownerId) return;
    const canEdit = contact.ownerId === ownerId || contact.memberIds?.includes(ownerId);
    if (!canEdit) return;

    setAudienceError(null);
    const count = parseCountInput(audienceDraft.countInput);
    if (count === null) {
      setAudienceError("Please enter a follower/subscriber count (e.g. 1200, 12.3k, 1.2m).");
      return;
    }
    if (audienceDraft.platform === "other" && !audienceDraft.label.trim()) {
      setAudienceError("Please enter a label for platform 'Other' (e.g. 'Newsletter').");
      return;
    }

    const entry: SocialFollower = {
      platform: audienceDraft.platform,
      count,
      metric: audienceDraft.metric,
      ...(audienceDraft.label.trim().length ? { label: audienceDraft.label.trim() } : {}),
      ...(audienceDraft.handle.trim().length ? { handle: audienceDraft.handle.trim() } : {}),
      ...(audienceDraft.url.trim().length ? { url: audienceDraft.url.trim() } : {}),
    };

    setAudienceIsSaving(true);
    try {
      const existing = getFollowers();
      const filtered =
        audienceEditingPlatform === null
          ? existing.filter((f) => f?.platform !== entry.platform)
          : existing.filter((f) => f?.platform !== audienceEditingPlatform);

      const next = [...filtered, entry].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
      await updateDoc(contactDocRef, {
        socialFollowers: next,
        updatedAt: nowServerTimestamp(),
      });
      setShowAudienceModal(false);
      setAudienceEditingPlatform(null);
      resetAudienceDraft(entry.platform);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save audience entry";
      setAudienceError(message);
    } finally {
      setAudienceIsSaving(false);
    }
  };

  const handleDeletePurchase = async (purchaseId: string) => {
    if (!contact || !ownerId) return;
    const canEdit = contact.ownerId === ownerId || contact.memberIds?.includes(ownerId);
    if (!canEdit) return;

    setPurchaseError(null);
    setPurchaseIsSaving(true);
    try {
      const next = getPurchases().filter((p) => p.id !== purchaseId);
      await updateDoc(contactDocRef, {
        purchases: next,
        updatedAt: nowServerTimestamp(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to remove purchase/sale";
      setPurchaseError(message);
    } finally {
      setPurchaseIsSaving(false);
    }
  };

  const handleSavePurchase = async () => {
    if (!contact || !ownerId) return;
    const canEdit = contact.ownerId === ownerId || contact.memberIds?.includes(ownerId);
    if (!canEdit) return;

    setPurchaseError(null);

    const name = purchaseDraft.name.trim();
    if (!name) {
      setPurchaseError("Please enter a purchase/sale name (e.g. 'Coaching plan' or 'Pro subscription').");
      return;
    }

    const amountRaw = purchaseDraft.amountInput.trim().replace(/,/g, "");
    let amount: number | undefined = undefined;
    if (amountRaw.length) {
      const parsed = Number(amountRaw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setPurchaseError("Amount must be a valid non-negative number (or leave it blank).");
        return;
      }
      amount = parsed;
    }

    const currency = purchaseDraft.currency.trim().toUpperCase();
    const notes = purchaseDraft.notes.trim();

    setPurchaseIsSaving(true);
    try {
      const existing = getPurchases();
      const nowMs = Date.now();
      const base: Omit<ContactPurchase, "id"> = {
        stage: purchaseStage,
        cadence: purchaseDraft.cadence,
        name,
        ...(typeof amount === "number" ? { amount } : {}),
        ...(currency ? { currency } : {}),
        ...(notes ? { notes } : {}),
      };

      const next = purchaseEditingId
        ? existing.map((p) =>
            p.id === purchaseEditingId
              ? ({
                  ...p,
                  ...base,
                  updatedAtMs: nowMs,
                } satisfies ContactPurchase)
              : p,
          )
        : [
            ...existing,
            ({
              id: crypto.randomUUID(),
              ...base,
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
            } satisfies ContactPurchase),
          ];

      await updateDoc(contactDocRef, {
        purchases: next,
        updatedAt: nowServerTimestamp(),
      });

      setShowPurchaseModal(false);
      setPurchaseEditingId(null);
      resetPurchaseDraft(purchaseDraft.cadence);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save purchase/sale";
      setPurchaseError(message);
    } finally {
      setPurchaseIsSaving(false);
    }
  };

  const linkifyCitations = (
    md: string,
    sources: Array<{ url?: string }>,
  ): string => {
    // Replace [n] with a markdown link if we have that source URL (1-indexed)
    return md.replace(/\[(\d+)\]/g, (m, nStr) => {
      const n = Number(nStr);
      if (!Number.isFinite(n) || n < 1) return m;
      const url = sources?.[n - 1]?.url;
      if (typeof url === "string" && url.trim().length) {
        return `[${n}](${url})`;
      }
      return m;
    });
  };

  const researchMarkdownLive = useMemo(() => {
    return linkifyCitations(sanitizeThink(researchStream), researchSources);
  }, [researchSources, researchStream]);

  const researchMarkdownSaved = useMemo(() => {
    return linkifyCitations(
      sanitizeThink(contact?.deepResearchRaw ?? ""),
      (contact?.deepResearchSources as any) ?? [],
    );
  }, [contact?.deepResearchRaw, contact?.deepResearchSources]);

  const researchHeadings = useMemo(() => {
    const md = navTab === "research" && researchMarkdownLive.trim().length
      ? researchMarkdownLive
      : researchMarkdownSaved;
    if (!md.trim()) return [];
    return extractHeadings(md);
  }, [navTab, researchMarkdownLive, researchMarkdownSaved]);

  const scrollToResearch = (id: string) => {
    setNavTab("research");
    // Let the DOM update before scrolling
    setTimeout(() => {
      const el = document.getElementById(id);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  };

  useEffect(() => {
    if (!contactMemberQuery) return;

    const unsubscribe = onSnapshot(
      contactMemberQuery,
      (snapshot) => {
        setIsLoading(false);
        if (snapshot.empty) {
          setContact(null);
          setForm(null);
          return;
        }
        const docSnap = snapshot.docs[0]!;
        const data = docSnap.data() as ContactDoc;
        setContact(data);
        setForm((prev) => {
          const newSummary = data.deepResearchSummary ?? data.notes ?? "";
          const nextBaseline = toFormState(data);
          if (!prev) {
            setLastContactSummary(newSummary);
            setLastContactFormBaseline(nextBaseline);
            return nextBaseline;
          }

          // Merge: update fields from Firestore only if the user hasn't edited them locally.
          const baseline = lastContactFormBaseline ?? prev;
          let merged: ContactFormState = prev;

          const syncIfUnedited = <K extends keyof ContactFormState>(key: K) => {
            if (prev[key] === baseline[key] && prev[key] !== nextBaseline[key]) {
              merged = { ...merged, [key]: nextBaseline[key] };
            }
          };

          // Identity + contact fields
          syncIfUnedited("fullName");
          syncIfUnedited("firstName");
          syncIfUnedited("lastName");
          syncIfUnedited("jobTitle");
          syncIfUnedited("companyName");
          syncIfUnedited("email");
          syncIfUnedited("phone");
          syncIfUnedited("linkedInUrl");
          syncIfUnedited("website");
          syncIfUnedited("location");
          syncIfUnedited("leadStatus");
          syncIfUnedited("tagsCsv");

          // Summary: only auto-sync if user hasn't edited (existing behavior)
          if (prev.summary === lastContactSummary && prev.summary !== newSummary) {
            merged = { ...merged, summary: newSummary };
          }

          // Update baselines for next snapshot comparison
          setLastContactSummary(newSummary);
          setLastContactFormBaseline(nextBaseline);

          return merged;
        });
      },
      (err) => {
        console.error("Contact snapshot error:", (err as any)?.code, (err as any)?.message, err);
        setIsLoading(false);
        setContact(null);
        setForm(null);
      },
    );

    return () => {
      unsubscribe();
    };
  }, [contactMemberQuery]);

  const notesQuery = useMemo(() => {
    if (!ownerId || !contactId) return null;
    return query(
      collection(db, "notes"),
      where("contactId", "==", contactId),
      where("memberIds", "array-contains", ownerId),
      orderBy("createdAt", "desc"),
      limit(100),
    );
  }, [contactId, ownerId]);

  useEffect(() => {
    if (!notesQuery) {
      setNotes([]);
      return;
    }

    const unsubscribe = onSnapshot(
      notesQuery,
      (snapshot) => {
        setNotes(snapshot.docs.map((d) => ({ id: d.id, data: d.data() as NoteDoc })));
      },
      (err) => {
        console.error("Notes query error:", err);
        setNotes([]);
      },
    );

    return () => {
      unsubscribe();
    };
  }, [notesQuery]);

  useEffect(() => {
    if (!savedMessage) return;
    const t = setTimeout(() => setSavedMessage(null), 2500);
    return () => clearTimeout(t);
  }, [savedMessage]);

  const handleChange =
    (key: keyof ContactFormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setSavedMessage(null);
      setForm((prev) => {
        if (!prev) return prev;
        return { ...prev, [key]: e.target.value };
      });
    };

  const handleSave = async () => {
    if (!form || !contact || !ownerId) return;
    const canEdit = contact.ownerId === ownerId || contact.memberIds?.includes(ownerId);
    if (!canEdit) return;

    setError(null);
    setSavedMessage(null);
    setIsSaving(true);
    try {
      const summaryValue = form.summary.trim() || null;
      await updateDoc(contactDocRef, {
        fullName: form.fullName.trim() || null,
        firstName: form.firstName.trim() || null,
        lastName: form.lastName.trim() || null,
        jobTitle: form.jobTitle.trim() || null,
        companyName: form.companyName.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        linkedInUrl: form.linkedInUrl.trim() || null,
        website: form.website.trim() || null,
        location: form.location.trim() || null,
        leadStatus: form.leadStatus || "not_sure",
        notes: summaryValue,
        deepResearchSummary: summaryValue,
        tags: parseTags(form.tagsCsv),
        isDraft: false,
        updatedAt: nowServerTimestamp(),
      });
      setSavedMessage("Saved");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Save failed";
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!contact || !ownerId) return;
    const canDelete = contact.ownerId === ownerId || contact.memberIds?.includes(ownerId);
    if (!canDelete) return;
    const contactName = contact.fullName || contact.firstName || "this contact";
    if (!confirm(`Are you sure you want to delete ${contactName}? This cannot be undone.`)) return;

    setIsDeleting(true);
    try {
      await deleteDoc(contactDocRef);
      router.push("/contacts");
    } catch (err) {
      console.error("Delete error:", err);
      alert("Failed to delete contact. Please try again.");
      setIsDeleting(false);
    }
  };

  const handleRunDeepResearch = async () => {
    if (!contact || !ownerId) return;
    const canEdit = contact.ownerId === ownerId || contact.memberIds?.includes(ownerId);
    if (!canEdit) return;
    setError(null);
    setIsResearching(true);
    setResearchStream("");
    setResearchReasoning("");
    setResearchSources([]);
    setResearchStage("starting");
    try {
      const auth = getFirebaseAuth();
      const user = auth.currentUser;
      if (!user) throw new Error("Not authenticated");
      const idToken = await getIdToken(user);

      const res = await fetch(`/api/contacts/${contactId}/deep-research/stream`, {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error || "Deep research failed");
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("Streaming not supported");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: any;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }

          if (evt.type === "status" && typeof evt.stage === "string") {
            setResearchStage(evt.stage);
          }
          if (evt.type === "reasoning" && typeof evt.text === "string") {
            setResearchReasoning((prev) => (prev ? prev + "\n" : "") + evt.text);
          }
          if (evt.type === "content" && typeof evt.text === "string") {
            setResearchStream((prev) => prev + evt.text);
          }
          if (evt.type === "sources" && Array.isArray(evt.sources)) {
            setResearchSources(evt.sources);
          }
          if (evt.type === "error" && typeof evt.message === "string") {
            throw new Error(evt.message);
          }
          if (evt.type === "done") {
            setSavedMessage("Deep research complete");
            // Avoid showing duplicate content: once research is saved to Firestore, prefer the saved doc.
            setResearchStream("");
            setResearchReasoning("");
            setResearchSources([]);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deep research failed");
    } finally {
      setIsResearching(false);
      setResearchStage(null);
    }
  };

  const handleUploadAvatar = async (file: File) => {
    if (!contact || !ownerId) return;
    const canEdit = contact.ownerId === ownerId || contact.memberIds?.includes(ownerId);
    if (!canEdit) {
      setAvatarError("You don't have permission to edit this contact.");
      return;
    }

    setAvatarError(null);

    const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
    if (!allowed.has(file.type)) {
      setAvatarError("Unsupported image type. Use PNG, JPG, or WebP.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setAvatarError("Image too large (max 10MB).");
      return;
    }

    setIsUploadingAvatar(true);
    try {
      const ext = file.type === "image/png"
        ? "png"
        : file.type === "image/webp"
          ? "webp"
          : "jpg";

      const storagePath = `users/${contact.ownerId}/contacts/${contactId}/avatar/avatar.${ext}`;
      await uploadBytes(ref(storage, storagePath), file, { contentType: file.type });
      await updateDoc(contactDocRef, {
        profileImagePath: storagePath,
        updatedAt: nowServerTimestamp(),
      });

      const url = await getDownloadURL(ref(storage, storagePath));
      const withBust = url.includes("?") ? `${url}&t=${Date.now()}` : `${url}?t=${Date.now()}`;
      setAvatarUrl(withBust);
      setSavedMessage("Profile photo updated");
    } catch (e) {
      console.error("Avatar upload error:", e);
      setAvatarError(e instanceof Error ? e.message : "Failed to upload profile photo");
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const resetAddInfo = () => {
    addInfoImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    setAddInfoImages([]);
    setAddInfoText("");
    setAddInfoEnableDeepResearch(false);
    setAddInfoStage(null);
    setAddInfoError(null);
    setAddInfoConflicts([]);
    setAddInfoPendingForce(false);
  };

  const handleAddInfoPickFiles = (input: HTMLInputElement | null) => {
    input?.click();
  };

  const handleAddInfoAddFiles = (files: File[]) => {
    setAddInfoError(null);
    const nextImages = files.filter(isImageFile).map(toLocalImage);
    if (nextImages.length === 0) {
      setAddInfoError("No image files found.");
      return;
    }

    const merged = [...addInfoImages, ...nextImages].slice(0, 6);
    if (merged.length !== addInfoImages.length + nextImages.length) {
      nextImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      setAddInfoError("Max 6 images allowed.");
    }
    setAddInfoImages(merged);
  };

  const handleAddInfoPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const files = items
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter((f): f is File => Boolean(f));
    if (files.length === 0) return;
    handleAddInfoAddFiles(files);
  };

  const handleAddInfoRemoveImage = (id: string) => {
    setAddInfoImages((prev) => {
      const target = prev.find((x) => x.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
  };

  const handleSubmitAddInfo = async (force: boolean) => {
    if (!contact || !ownerId) return;
    const canEdit = contact.ownerId === ownerId || contact.memberIds?.includes(ownerId);
    if (!canEdit) {
      setAddInfoError("You don't have permission to edit this contact.");
      return;
    }

    if (addInfoImages.length === 0 && addInfoText.trim().length === 0) {
      setAddInfoError("Please paste some text or upload at least one image.");
      return;
    }

    setAddInfoIsSubmitting(true);
    setAddInfoError(null);
    setAddInfoConflicts([]);
    setAddInfoStage("Uploading…");

    try {
      const auth = getFirebaseAuth();
      const user = auth.currentUser;
      if (!user) throw new Error("Not authenticated");
      const idToken = await getIdToken(user);

      const formData = new FormData();
      formData.append("text", addInfoText);
      formData.append("enableDeepResearch", addInfoEnableDeepResearch.toString());
      formData.append("force", force ? "true" : "false");
      addInfoImages.forEach((img, idx) => {
        formData.append(`image${idx + 1}`, img.file);
      });

      setAddInfoStage("Analyzing…");
      const res = await fetch(`/api/contacts/${contactId}/ingest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
        body: formData,
      });

      const json = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setAddInfoConflicts(Array.isArray(json?.conflicts) ? json.conflicts : []);
        setAddInfoPendingForce(true);
        setAddInfoStage(null);
        return;
      }

      if (!res.ok) {
        throw new Error(json?.error || "Failed to add info");
      }

      setSavedMessage("Info applied to contact");
      setShowAddInfoModal(false);
      resetAddInfo();

      if (json?.deepResearchQueued && addInfoEnableDeepResearch) {
        setNavTab("research");
        // kick off existing streaming deep research flow
        void handleRunDeepResearch();
      }
    } catch (err) {
      setAddInfoError(err instanceof Error ? err.message : "Failed to add info");
    } finally {
      setAddInfoIsSubmitting(false);
      setAddInfoStage(null);
    }
  };

  const handleCreateNote = async () => {
    if (!ownerId || !contact || !newNoteContent.trim()) return;
    const canEdit = contact.ownerId === ownerId || contact.memberIds?.includes(ownerId);
    if (!canEdit) {
      setError("You don't have permission to create notes for this contact");
      return;
    }

    setIsCreatingNote(true);
    setError(null);

    try {
      // Ensure ownerId is always in memberIds
      const memberIds = contact.memberIds ?? [ownerId];
      const finalMemberIds = memberIds.includes(ownerId) ? memberIds : [...memberIds, ownerId];

      await addDoc(collection(db, "notes"), {
        contactId,
        ownerId,
        crmId: contact.crmId ?? undefined,
        memberIds: finalMemberIds,
        content: newNoteContent.trim(),
        createdAt: nowServerTimestamp(),
        updatedAt: nowServerTimestamp(),
      } satisfies Omit<NoteDoc, "createdAt" | "updatedAt"> & { createdAt: unknown; updatedAt: unknown });

      setNewNoteContent("");
      setSavedMessage("Note created");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create note");
    } finally {
      setIsCreatingNote(false);
    }
  };

  const handleDeleteNote = async (noteId: string, noteData: NoteDoc) => {
    if (!ownerId) return;
    const canDelete = noteData.ownerId === ownerId || noteData.memberIds?.includes(ownerId);
    if (!canDelete) {
      setError("You don't have permission to delete this note");
      return;
    }

    if (!confirm("Are you sure you want to delete this note? This cannot be undone.")) return;

    setDeletingNoteId(noteId);
    setError(null);

    try {
      await deleteDoc(doc(db, "notes", noteId));
      setSavedMessage("Note deleted");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete note");
    } finally {
      setDeletingNoteId(null);
    }
  };

  useEffect(() => {
    if (!contact?.researchImages?.length) {
      setResearchImageUrls([]);
      return;
    }
    let cancelled = false;
    const run = async () => {
      const previews = await Promise.all(
        contact.researchImages!.slice(0, 12).map(async (img) => {
          try {
            const url = await getDownloadURL(ref(storage, img.storagePath));
            return { path: img.storagePath, url };
          } catch {
                    // Helps diagnose Storage rules issues
                    // eslint-disable-next-line no-console
                    console.error("Research image download error:", img.storagePath);
            return { path: img.storagePath, url: null };
          }
        }),
      );
      if (!cancelled) setResearchImageUrls(previews);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [contact?.researchImages]);

  useEffect(() => {
    if (!contact?.profileImagePath) {
      setAvatarUrl(null);
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const url = await getDownloadURL(ref(storage, contact.profileImagePath!));
        const withBust = url.includes("?") ? `${url}&t=${Date.now()}` : `${url}?t=${Date.now()}`;
        if (!cancelled) setAvatarUrl(withBust);
      } catch {
        if (!cancelled) setAvatarUrl(null);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [contact?.profileImagePath]);

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <div className="text-sm text-zinc-600">Loading contact…</div>
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h1 className="text-lg font-semibold tracking-tight">Contact not found</h1>
        <p className="mt-1 text-sm text-zinc-600">
          This contact may not exist, or you may not have access.
        </p>
        <div className="mt-4">
          <button
            type="button"
            onClick={() => router.push("/contacts")}
            className="rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-900 hover:bg-zinc-100"
            aria-label="Back to contacts"
          >
            Back to contacts
          </button>
        </div>
      </div>
    );
  }

  if (ownerId && contact.ownerId !== ownerId) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h1 className="text-lg font-semibold tracking-tight">Not authorized</h1>
        <p className="mt-1 text-sm text-zinc-600">You don’t have access to this contact.</p>
      </div>
    );
  }

  if (!form) return null;

  const ResearchMarkdown = ({ value }: { value: string }) => {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => (
            <a
              {...props}
              className="text-blue-700 underline underline-offset-2"
              target="_blank"
              rel="noreferrer"
            />
          ),
          h1: ({ node, ...props }) => {
            const text = getNodeText(props.children);
            const id = slugify(text || "section");
            return (
              <h2 id={id} className="mt-6 scroll-mt-24 text-lg font-semibold text-zinc-900">
                {props.children}
              </h2>
            );
          },
          h2: ({ node, ...props }) => {
            const text = getNodeText(props.children);
            const id = slugify(text || "section");
            return (
              <h3 id={id} className="mt-5 scroll-mt-24 text-base font-semibold text-zinc-900">
                {props.children}
              </h3>
            );
          },
          h3: ({ node, ...props }) => {
            const text = getNodeText(props.children);
            const id = slugify(text || "section");
            return (
              <h4 id={id} className="mt-4 scroll-mt-24 text-sm font-semibold text-zinc-900">
                {props.children}
              </h4>
            );
          },
          p: ({ node, ...props }) => <p {...props} className="mt-2 leading-6" />,
          ul: ({ node, ...props }) => <ul {...props} className="mt-2 list-disc pl-6" />,
          ol: ({ node, ...props }) => <ol {...props} className="mt-2 list-decimal pl-6" />,
          li: ({ node, ...props }) => <li {...props} className="mt-1" />,
          blockquote: ({ node, ...props }) => (
            <blockquote
              {...props}
              className="mt-3 border-l-4 border-zinc-200 pl-4 text-zinc-700"
            />
          ),
          code: ({ node, ...props }) => (
            <code
              {...props}
              className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[0.9em]"
            />
          ),
        }}
      >
        {value}
      </ReactMarkdown>
    );
  };

  const showResearch = navTab === "research";
  const showNotes = navTab === "notes";

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_1fr_260px]">
      {/* Left sidebar (nav) */}
      <aside className="hidden lg:block">
        <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-auto rounded-2xl border border-zinc-200 bg-white p-3">
          <div className="px-2 pb-2 text-xs font-medium text-zinc-600">Navigate</div>

          <button
            type="button"
            onClick={() => setNavTab("contact")}
            className={`w-full rounded-xl px-3 py-2 text-left text-sm font-medium ${
              navTab === "contact"
                ? "bg-zinc-900 text-white"
                : "text-zinc-900 hover:bg-zinc-50"
            }`}
          >
            Contact
          </button>

          <button
            type="button"
            onClick={() => setNavTab("notes")}
            className={`mt-1 w-full rounded-xl px-3 py-2 text-left text-sm font-medium ${
              navTab === "notes"
                ? "bg-zinc-900 text-white"
                : "text-zinc-900 hover:bg-zinc-50"
            }`}
          >
            Notes
          </button>

          <button
            type="button"
            onClick={() => {
              setNavTab("research");
              setResearchNavOpen((v) => !v);
            }}
            className={`mt-1 flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm font-medium ${
              navTab === "research"
                ? "bg-blue-50 text-blue-900"
                : "text-zinc-900 hover:bg-zinc-50"
            }`}
          >
            <span>Research</span>
            <span className="text-xs text-zinc-500">{researchNavOpen ? "▾" : "▸"}</span>
          </button>

          {researchNavOpen && researchHeadings.length ? (
            <div className="mt-2 space-y-1 px-1">
              {researchHeadings.slice(0, 60).map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => scrollToResearch(h.id)}
                  className={`w-full rounded-lg px-2 py-1 text-left text-xs text-zinc-700 hover:bg-zinc-50 ${
                    h.level >= 3 ? "pl-5" : h.level === 2 ? "pl-4" : "pl-3"
                  }`}
                  aria-label={`Jump to ${h.text}`}
                >
                  {h.text}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </aside>

      {/* Main content */}
      <main className="space-y-6">
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <div
              className="relative"
              onPaste={(event) => {
                // Allow pasting an image from clipboard (Ctrl+V) to set the avatar.
                const items = Array.from(event.clipboardData?.items ?? []);
                const files = items
                  .filter((i) => i.kind === "file")
                  .map((i) => i.getAsFile())
                  .filter((f): f is File => Boolean(f));
                if (files.length === 0) return;
                const img = files.find((f) => f.type.startsWith("image/")) ?? files[0]!;
                event.preventDefault();
                void handleUploadAvatar(img);
              }}
              tabIndex={0}
              aria-label="Contact avatar (click to upload or paste an image)"
              title="Click then paste (Ctrl+V) to set photo"
            >
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  void handleUploadAvatar(f);
                }}
              />
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                disabled={isUploadingAvatar}
                className="relative h-12 w-12 overflow-hidden rounded-full border border-zinc-200 bg-zinc-100 text-sm font-semibold text-zinc-700 hover:bg-zinc-200 disabled:opacity-60"
                aria-label="Upload contact profile photo"
                title="Upload profile photo"
              >
                {avatarUrl ? (
                  <Image src={avatarUrl} alt="Contact profile photo" fill className="object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center">
                    {(
                      (contact.fullName?.trim() ||
                        [contact.firstName?.trim(), contact.lastName?.trim()].filter(Boolean).join(" ") ||
                        contact.email?.trim() ||
                        "C")[0] || "C"
                    ).toUpperCase()}
                  </span>
                )}
              </button>
            </div>

            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                {contact.fullName?.trim()
                  ? contact.fullName.trim()
                  : [contact.firstName?.trim(), contact.lastName?.trim()].filter(Boolean).join(" ") ||
                    "Unnamed contact"}
              </h1>
              <p className="mt-1 text-sm text-zinc-600">
                {contact.companyName?.trim() ? contact.companyName.trim() : "Contact details"}
                {contact.jobTitle?.trim() ? ` · ${contact.jobTitle.trim()}` : ""}
              </p>
              {avatarError ? (
                <div className="mt-1 text-xs text-red-700">{avatarError}</div>
              ) : null}
            </div>
          </div>

          {/* Lead status (top-right) */}
          {form ? (
            <div className="hidden sm:flex items-center justify-end">
              <div className="text-right">
                <div className="text-xs font-medium text-zinc-600">Status</div>
                <select
                  value={form.leadStatus}
                  onChange={(e) => {
                    const v = e.target.value as ContactFormState["leadStatus"];
                    setSavedMessage(null);
                    setForm((prev) => (prev ? { ...prev, leadStatus: v } : prev));
                  }}
                  className="mt-1 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none hover:bg-zinc-50 focus:border-zinc-400"
                  aria-label="Lead status"
                >
                  <option value="not_sure">Not sure</option>
                  <option value="cold">Cold</option>
                  <option value="warm">Warm</option>
                  <option value="hot">Hot</option>
                  <option value="customer">Converted</option>
                </select>
              </div>
            </div>
          ) : null}

          {/* Mobile quick actions */}
          <div className="flex items-center gap-2 lg:hidden">
            <button
              type="button"
              onClick={() => setNavTab("contact")}
              className={`rounded-xl px-3 py-2 text-sm font-medium ${
                navTab === "contact" ? "bg-zinc-900 text-white" : "border border-zinc-200 bg-white"
              }`}
            >
              Contact
            </button>
            <button
              type="button"
              onClick={() => setNavTab("notes")}
              className={`rounded-xl px-3 py-2 text-sm font-medium ${
                navTab === "notes" ? "bg-zinc-900 text-white" : "border border-zinc-200 bg-white"
              }`}
            >
              Notes
            </button>
            <button
              type="button"
              onClick={() => setNavTab("research")}
              className={`rounded-xl px-3 py-2 text-sm font-medium ${
                navTab === "research" ? "bg-blue-600 text-white" : "border border-zinc-200 bg-white"
              }`}
            >
              Research
            </button>
          </div>
        </div>

        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {showNotes ? (
          <>
            {/* Notes view */}
            <div className="rounded-2xl border border-zinc-200 bg-white p-4">
              <div className="text-sm font-medium text-zinc-900">New Note</div>
              <div className="mt-3">
                <textarea
                  value={newNoteContent}
                  onChange={(e) => setNewNoteContent(e.target.value)}
                  className="min-h-32 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                  placeholder="Write a note about this contact…"
                  aria-label="New note content"
                />
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={handleCreateNote}
                  disabled={isCreatingNote || !newNoteContent.trim()}
                  className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Create note"
                >
                  {isCreatingNote ? "Creating…" : "Create Note"}
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-zinc-200 bg-white p-4">
              <div className="text-sm font-medium text-zinc-900">
                Notes ({notes.length})
              </div>
              {notes.length ? (
                <div className="mt-4 space-y-4">
                  {notes.map(({ id, data }) => {
                    const createdAt = data.createdAt as { seconds?: number; toDate?: () => Date } | null;
                    const dateStr = createdAt?.toDate
                      ? createdAt.toDate().toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "Unknown date";
                    const canDelete = ownerId && (data.ownerId === ownerId || data.memberIds?.includes(ownerId));
                    const isDeleting = deletingNoteId === id;

                    return (
                      <div
                        key={id}
                        className="rounded-xl border border-zinc-200 bg-zinc-50 p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1">
                            <div className="whitespace-pre-wrap text-sm text-zinc-900">
                              {data.content}
                            </div>
                            <div className="mt-2 text-xs text-zinc-500">{dateStr}</div>
                          </div>
                          {canDelete ? (
                            <button
                              type="button"
                              onClick={() => handleDeleteNote(id, data)}
                              disabled={isDeleting}
                              className="rounded-lg border border-red-200 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                              aria-label="Delete note"
                            >
                              {isDeleting ? "Deleting…" : "Delete"}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-4 text-center py-8 text-sm text-zinc-600">
                  No notes yet. Create your first note above.
                </div>
              )}
            </div>
          </>
        ) : !showResearch ? (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-zinc-200 bg-white p-4">
                <div className="text-sm font-medium text-zinc-900">Identity</div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-zinc-700" htmlFor="fullName">
                      Full name
                    </label>
                    <input
                      id="fullName"
                      value={form.fullName}
                      onChange={handleChange("fullName")}
                      className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-zinc-700" htmlFor="jobTitle">
                      Job title
                    </label>
                    <input
                      id="jobTitle"
                      value={form.jobTitle}
                      onChange={handleChange("jobTitle")}
                      className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-zinc-700" htmlFor="companyName">
                      Company
                    </label>
                    <input
                      id="companyName"
                      value={form.companyName}
                      onChange={handleChange("companyName")}
                      className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-zinc-700" htmlFor="location">
                      Location
                    </label>
                    <input
                      id="location"
                      value={form.location}
                      onChange={handleChange("location")}
                      className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-zinc-700" htmlFor="firstName">
                      First name
                    </label>
                    <input
                      id="firstName"
                      value={form.firstName}
                      onChange={handleChange("firstName")}
                      className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-zinc-700" htmlFor="lastName">
                      Last name
                    </label>
                    <input
                      id="lastName"
                      value={form.lastName}
                      onChange={handleChange("lastName")}
                      className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                    />
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-zinc-200 bg-white p-4">
                <div className="text-sm font-medium text-zinc-900">Contact</div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-zinc-700" htmlFor="email">
                      Email
                    </label>
                    <input
                      id="email"
                      value={form.email}
                      onChange={handleChange("email")}
                      className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                      inputMode="email"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-zinc-700" htmlFor="phone">
                      Phone
                    </label>
                    <input
                      id="phone"
                      value={form.phone}
                      onChange={handleChange("phone")}
                      className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                      inputMode="tel"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-zinc-700" htmlFor="linkedInUrl">
                      LinkedIn URL
                    </label>
                    <input
                      id="linkedInUrl"
                      value={form.linkedInUrl}
                      onChange={handleChange("linkedInUrl")}
                      className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-zinc-700" htmlFor="website">
                      Website
                    </label>
                    <input
                      id="website"
                      value={form.website}
                      onChange={handleChange("website")}
                      className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                    />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <label className="text-xs font-medium text-zinc-700" htmlFor="tags">
                      Tags (comma-separated)
                    </label>
                    <input
                      id="tags"
                      value={form.tagsCsv}
                      onChange={handleChange("tagsCsv")}
                      className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Purchases / Sales (conditional by status) */}
            {(() => {
              const status = form?.leadStatus ?? "not_sure";
              const canShowPossible = status === "warm" || status === "hot";
              const canShowConverted = status === "customer";
              const purchases = getPurchases();
              const possible = purchases.filter((p) => p.stage === "possible");
              const converted = purchases.filter((p) => p.stage === "converted");

              if (!canShowPossible && !canShowConverted && possible.length === 0 && converted.length === 0) return null;

              const section = canShowConverted ? "converted" : "possible";
              const title = canShowConverted ? "Converted sales" : "Possible purchases";
              const list = canShowConverted ? converted : possible;

              return (
                <div className="rounded-2xl border border-zinc-200 bg-white p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-zinc-900">{title}</div>
                      <div className="mt-0.5 text-xs text-zinc-600">
                        {canShowConverted
                          ? "Track what they purchased after conversion. Add as many line items as you need."
                          : "Track what they might buy. Add as many line items as you need."}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        handleOpenAddPurchase(section);
                      }}
                      className="rounded-xl bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                      disabled={purchaseIsSaving}
                      aria-label={canShowConverted ? "Add converted sale" : "Add possible purchase"}
                    >
                      Add
                    </button>
                  </div>

                  {purchaseError ? (
                    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      {purchaseError}
                    </div>
                  ) : null}

                  {list.length ? (
                    <div className="mt-4 space-y-2">
                      {list.map((p) => (
                        <div
                          key={p.id}
                          className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2"
                          aria-label={`${stageLabel(p.stage)}: ${p.name}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-zinc-900">{p.name}</div>
                              <div className="mt-0.5 text-xs text-zinc-600">
                                {cadenceLabel(p.cadence)}
                                {typeof p.amount === "number" ? (
                                  <>
                                    {" "}
                                    ·{" "}
                                    <span className="font-medium text-zinc-800">
                                      {p.currency?.trim() ? `${p.currency.trim().toUpperCase()} ` : ""}
                                      {p.amount}
                                    </span>
                                  </>
                                ) : null}
                              </div>
                              {p.notes ? <div className="mt-1 text-xs text-zinc-700">{p.notes}</div> : null}
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleOpenEditPurchase(p)}
                                className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-900 hover:bg-zinc-100"
                                aria-label={`Edit ${p.name}`}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeletePurchase(p.id)}
                                disabled={purchaseIsSaving}
                                className="rounded-lg border border-red-200 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                                aria-label={`Remove ${p.name}`}
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-4 text-xs text-zinc-600">
                      No {canShowConverted ? "sales" : "purchases"} yet. Click “Add” to create your first one.
                    </div>
                  )}

                  {!canShowPossible && !canShowConverted ? (
                    <div className="mt-3 text-xs text-zinc-600">
                      Tip: set Status to <span className="font-medium">Warm</span>, <span className="font-medium">Hot</span>, or{" "}
                      <span className="font-medium">Converted</span> to add items quickly.
                    </div>
                  ) : null}
                </div>
              );
            })()}

            {/* Summary section + extra links */}
            <div className="rounded-2xl border border-zinc-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium text-zinc-900">Summary</div>
                {contact.deepResearchStatus ? (
                  <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                    Research: {contact.deepResearchStatus}
                  </span>
                ) : null}
              </div>
              <div className="mt-3">
                <textarea
                  value={form.summary}
                  onChange={handleChange("summary")}
                  className="min-h-28 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                  aria-label="Summary"
                  placeholder="Summary…"
                />
              </div>

              {(() => {
                const followers = getFollowers()
                  .filter((f) => f && typeof f.count === "number" && Number.isFinite(f.count) && f.count >= 0)
                  .slice(0, 24);

                return (
                  <div className="mt-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-medium text-zinc-700">Audience</div>
                      <button
                        type="button"
                        onClick={handleOpenAddAudience}
                        className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-900 hover:bg-zinc-100"
                        aria-label="Add audience card"
                      >
                        Add
                      </button>
                    </div>

                    {followers.length ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {followers.map((f, idx) => {
                          const label = (f.label?.trim() ? f.label.trim() : platformLabel(f.platform)) || "Social";
                          const metric = f.metric === "subscribers" ? "subs" : "followers";
                          return (
                            <div
                              key={`${f.platform}:${f.url ?? ""}:${idx}`}
                              className="min-w-[170px] rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="text-xs font-medium text-zinc-700">{label}</div>
                                <div className="flex shrink-0 items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleOpenEditAudience(f)}
                                    className="rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-zinc-800 hover:bg-zinc-100"
                                    aria-label={`Edit ${label} audience card`}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteAudience(f.platform)}
                                    disabled={audienceIsSaving}
                                    className="rounded-md border border-red-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                                    aria-label={`Remove ${label} audience card`}
                                  >
                                    Remove
                                  </button>
                                </div>
                              </div>

                              <div className="mt-0.5 text-sm font-semibold text-zinc-900">
                                {formatCompact(f.count)}{" "}
                                <span className="text-xs font-medium text-zinc-600">{metric}</span>
                              </div>
                              {f.handle ? <div className="mt-0.5 truncate text-xs text-zinc-600">{f.handle}</div> : null}
                              {f.url ? (
                                <a
                                  href={f.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-1 block truncate text-xs text-blue-700 underline underline-offset-2"
                                  aria-label={`Open ${label} link`}
                                >
                                  {f.url}
                                </a>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="mt-2 text-xs text-zinc-600">No audience stats yet. Add one manually or run research.</div>
                    )}

                    {audienceError ? (
                      <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        {audienceError}
                      </div>
                    ) : null}
                  </div>
                );
              })()}

              {contact.extraLinks?.length ? (
                <div className="mt-4">
                  <div className="text-xs font-medium text-zinc-700">Additional links</div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {contact.extraLinks.slice(0, 12).map((l) => (
                      <a
                        key={`${l.label}:${l.url}`}
                        href={l.url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 hover:bg-zinc-100"
                      >
                        <div className="text-xs font-medium text-zinc-700">{l.label}</div>
                        <div className="mt-1 truncate text-xs text-blue-700 underline underline-offset-2">
                          {l.url}
                        </div>
                      </a>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            {showPurchaseModal ? (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-lg font-semibold text-zinc-900">
                      {purchaseEditingId ? "Edit item" : "Add item"}
                    </h2>
                    <button
                      type="button"
                      onClick={() => {
                        setShowPurchaseModal(false);
                        setPurchaseEditingId(null);
                        setPurchaseError(null);
                      }}
                      className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-900 hover:bg-zinc-100"
                      aria-label="Close purchases modal"
                    >
                      Close
                    </button>
                  </div>

                  <div className="mt-1 text-xs text-zinc-600">{stageLabel(purchaseStage)}</div>

                  <div className="mt-4 grid gap-3">
                    <label className="block">
                      <div className="text-xs font-medium text-zinc-700">Type</div>
                      <select
                        value={purchaseDraft.cadence}
                        onChange={(e) =>
                          setPurchaseDraft((prev) => ({ ...prev, cadence: e.target.value as PurchaseCadence }))
                        }
                        className="mt-1 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400"
                        aria-label="Purchase type"
                      >
                        <option value="monthly">Monthly subscription</option>
                        <option value="yearly">Yearly subscription</option>
                        <option value="one_off">One-off</option>
                      </select>
                    </label>

                    <label className="block">
                      <div className="text-xs font-medium text-zinc-700">Name</div>
                      <input
                        value={purchaseDraft.name}
                        onChange={(e) => setPurchaseDraft((prev) => ({ ...prev, name: e.target.value }))}
                        className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                        placeholder="e.g. Pro plan, Coaching, Implementation"
                        aria-label="Purchase name"
                      />
                    </label>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block">
                        <div className="text-xs font-medium text-zinc-700">Amount (optional)</div>
                        <input
                          value={purchaseDraft.amountInput}
                          onChange={(e) => setPurchaseDraft((prev) => ({ ...prev, amountInput: e.target.value }))}
                          className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                          placeholder="e.g. 99"
                          inputMode="decimal"
                          aria-label="Amount"
                        />
                      </label>
                      <label className="block">
                        <div className="text-xs font-medium text-zinc-700">Currency (optional)</div>
                        <input
                          value={purchaseDraft.currency}
                          onChange={(e) => setPurchaseDraft((prev) => ({ ...prev, currency: e.target.value }))}
                          className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm uppercase outline-none focus:border-zinc-400"
                          placeholder="e.g. USD"
                          aria-label="Currency"
                        />
                      </label>
                    </div>

                    <label className="block">
                      <div className="text-xs font-medium text-zinc-700">Notes (optional)</div>
                      <textarea
                        value={purchaseDraft.notes}
                        onChange={(e) => setPurchaseDraft((prev) => ({ ...prev, notes: e.target.value }))}
                        className="mt-1 min-h-24 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                        placeholder="Anything useful (timing, package details, objections)…"
                        aria-label="Purchase notes"
                      />
                    </label>
                  </div>

                  {purchaseError ? (
                    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                      {purchaseError}
                    </div>
                  ) : null}

                  <div className="mt-5 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setShowPurchaseModal(false);
                        setPurchaseEditingId(null);
                        setPurchaseError(null);
                      }}
                      className="rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-100"
                      aria-label="Cancel purchase changes"
                      disabled={purchaseIsSaving}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleSavePurchase}
                      className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                      aria-label="Save purchase"
                      disabled={purchaseIsSaving}
                    >
                      {purchaseIsSaving ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {showAudienceModal ? (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-lg font-semibold text-zinc-900">
                      {audienceEditingPlatform ? "Edit audience" : "Add audience"}
                    </h2>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAudienceModal(false);
                        setAudienceEditingPlatform(null);
                        setAudienceError(null);
                      }}
                      className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-900 hover:bg-zinc-100"
                      aria-label="Close audience modal"
                    >
                      Close
                    </button>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <div className="text-xs font-medium text-zinc-700">Platform</div>
                      <select
                        value={audienceDraft.platform}
                        onChange={(e) => {
                          const next = e.target.value as SocialPlatform;
                          setAudienceDraft((prev) => ({
                            ...prev,
                            platform: next,
                            metric: next === "youtube" ? "subscribers" : "followers",
                          }));
                        }}
                        className="mt-1 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400"
                        aria-label="Select platform"
                      >
                        <option value="x">X</option>
                        <option value="instagram">Instagram</option>
                        <option value="linkedin">LinkedIn</option>
                        <option value="youtube">YouTube</option>
                        <option value="tiktok">TikTok</option>
                        <option value="facebook">Facebook</option>
                        <option value="threads">Threads</option>
                        <option value="github">GitHub</option>
                        <option value="reddit">Reddit</option>
                        <option value="pinterest">Pinterest</option>
                        <option value="twitch">Twitch</option>
                        <option value="other">Other</option>
                      </select>
                    </label>

                    <label className="block">
                      <div className="text-xs font-medium text-zinc-700">Count</div>
                      <input
                        value={audienceDraft.countInput}
                        onChange={(e) => setAudienceDraft((prev) => ({ ...prev, countInput: e.target.value }))}
                        placeholder="e.g. 1200 or 12.3k"
                        className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                        aria-label="Follower/subscriber count"
                        inputMode="decimal"
                      />
                    </label>

                    <label className="block">
                      <div className="text-xs font-medium text-zinc-700">Metric</div>
                      <select
                        value={audienceDraft.metric}
                        onChange={(e) =>
                          setAudienceDraft((prev) => ({ ...prev, metric: e.target.value as SocialFollowerMetric }))
                        }
                        className="mt-1 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400"
                        aria-label="Metric"
                      >
                        <option value="followers">Followers</option>
                        <option value="subscribers">Subscribers</option>
                      </select>
                    </label>

                    <label className="block">
                      <div className="text-xs font-medium text-zinc-700">Handle (optional)</div>
                      <input
                        value={audienceDraft.handle}
                        onChange={(e) => setAudienceDraft((prev) => ({ ...prev, handle: e.target.value }))}
                        placeholder="@handle"
                        className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                        aria-label="Handle"
                      />
                    </label>

                    <label className="block sm:col-span-2">
                      <div className="text-xs font-medium text-zinc-700">URL (optional)</div>
                      <input
                        value={audienceDraft.url}
                        onChange={(e) => setAudienceDraft((prev) => ({ ...prev, url: e.target.value }))}
                        placeholder="https://…"
                        className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                        aria-label="Profile URL"
                      />
                    </label>

                    <label className="block sm:col-span-2">
                      <div className="text-xs font-medium text-zinc-700">
                        Label (optional{audienceDraft.platform === "other" ? ", required for Other" : ""})
                      </div>
                      <input
                        value={audienceDraft.label}
                        onChange={(e) => setAudienceDraft((prev) => ({ ...prev, label: e.target.value }))}
                        placeholder={audienceDraft.platform === "other" ? "e.g. Newsletter" : "e.g. Personal brand"}
                        className="mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                        aria-label="Label"
                      />
                    </label>
                  </div>

                  {audienceError ? (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      {audienceError}
                    </div>
                  ) : null}

                  <div className="mt-5 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setShowAudienceModal(false);
                        setAudienceEditingPlatform(null);
                        setAudienceError(null);
                      }}
                      disabled={audienceIsSaving}
                      className="rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-100 disabled:opacity-50"
                      aria-label="Cancel audience modal"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveAudience}
                      disabled={audienceIsSaving}
                      className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                      aria-label="Save audience"
                    >
                      {audienceIsSaving ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <>
            {/* Deep research status + summary + dynamic fields */}
            <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-medium text-blue-900">Deep Research</div>
                <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                  {contact.deepResearchStatus ?? "disabled"}
                </span>
              </div>

              {contact.deepResearchSummary ? (
                <div className="mt-3 whitespace-pre-wrap rounded-xl bg-white px-4 py-3 text-sm text-zinc-700">
                  {contact.deepResearchSummary}
                </div>
              ) : (
                <div className="mt-3 text-sm text-zinc-700">
                  {contact.deepResearchStatus === "running"
                    ? "Research in progress…"
                    : "No deep research summary yet."}
                </div>
              )}

              {isResearching && researchStage ? (
                <div className="mt-3 text-xs text-blue-700">Stage: {researchStage}</div>
              ) : null}

              {(() => {
                const savedCount = Array.isArray((contact as any)?.deepResearchSources)
                  ? ((contact as any).deepResearchSources as any[]).length
                  : 0;
                const liveCount = researchSources.length;
                const count = isResearching ? liveCount : savedCount;
                if (!count) return null;
                return (
                  <div className="mt-3 text-xs text-blue-700">
                    Sources found: {count}
                  </div>
                );
              })()}

              {isResearching && researchReasoning.trim().length ? (
                <details className="mt-3 rounded-xl bg-white px-4 py-3">
                  <summary className="cursor-pointer text-xs font-medium text-zinc-700">
                    Show reasoning
                  </summary>
                  <div className="mt-2 whitespace-pre-wrap text-xs text-zinc-600">
                    {researchReasoning}
                  </div>
                </details>
              ) : null}

              {isResearching && researchMarkdownLive.trim().length ? (
                <div className="mt-4 rounded-xl bg-white px-4 py-3 text-sm text-zinc-800">
                  <ResearchMarkdown value={researchMarkdownLive} />
                </div>
              ) : null}

              {contact.researchFields && Object.keys(contact.researchFields).length ? (
                <div className="mt-4 rounded-xl bg-white p-3">
                  <div className="text-xs font-medium text-zinc-700">Extra fields</div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {Object.entries(contact.researchFields)
                      .filter(([_, v]) => typeof v === "string" && v.trim().length > 0)
                      .map(([k, v]) => (
                        <div key={k} className="rounded-lg border border-zinc-200 px-3 py-2">
                          <div className="text-xs font-medium text-zinc-700">{k}</div>
                          <div className="mt-1 break-words text-sm text-zinc-900">{v as string}</div>
                        </div>
                      ))}
                  </div>
                </div>
              ) : null}

              {researchImageUrls.length ? (
                <div className="mt-4 rounded-xl bg-white p-3">
                  <div className="text-xs font-medium text-zinc-700">Images found</div>
                  <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {researchImageUrls.map((img) => (
                      <div
                        key={img.path}
                        className="relative overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50"
                      >
                        <div className="relative aspect-square">
                          {img.url ? (
                            <Image src={img.url} alt="Research image" fill className="object-cover" />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-xs text-zinc-500">
                              Preview unavailable
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {contact.deepResearchError ? (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {contact.deepResearchError}
                </div>
              ) : null}
            </div>

            {/* Full report (saved) */}
            {researchMarkdownSaved.trim().length ? (
              <details className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
                <summary className="cursor-pointer list-none">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium text-blue-900">Full research report</div>
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                        Perplexity
                      </span>
                      <span className="text-xs text-blue-700">▾</span>
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-blue-800">
                    This is the full saved report. The card above shows the summary + extracted fields.
                  </div>
                </summary>
                <div className="mt-3 rounded-xl bg-white px-4 py-3 text-sm text-zinc-800">
                  <ResearchMarkdown value={researchMarkdownSaved} />
                </div>
              </details>
            ) : null}
          </>
        )}
      </main>

      {/* Right sidebar (actions) */}
      <aside className="hidden lg:block">
        <div className="sticky top-20 rounded-2xl border border-zinc-200 bg-white p-3">
          <div className="px-2 pb-2 text-xs font-medium text-zinc-600">Actions</div>
          <div className="flex flex-col gap-2 px-2">
            <button
              type="button"
              onClick={() => {
                setAddInfoError(null);
                setAddInfoConflicts([]);
                setAddInfoPendingForce(false);
                setShowAddInfoModal(true);
              }}
              disabled={addInfoIsSubmitting}
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-50"
            >
              {addInfoIsSubmitting ? "Working…" : "Add Info (text/images)"}
            </button>
            <button
              type="button"
              onClick={handleRunDeepResearch}
              disabled={isResearching}
              className="rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
            >
              {isResearching ? "Researching…" : "Run Deep Research"}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="rounded-xl bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {isSaving ? "Saving…" : "Save Contact"}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={isDeleting}
              className="rounded-xl border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </button>
          </div>

          {savedMessage ? (
            <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              {savedMessage}
            </div>
          ) : null}

          {error ? (
            <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          ) : null}
        </div>
      </aside>

  {/* Add Info Modal */}
  {showAddInfoModal ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-3xl rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-zinc-900">Add info to this contact</h2>
            <p className="mt-1 text-sm text-zinc-600">
              Paste text and/or upload up to 6 images. We’ll extract new details and update this contact.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setShowAddInfoModal(false);
              resetAddInfo();
            }}
            className="rounded-xl px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
            aria-label="Close add info modal"
            disabled={addInfoIsSubmitting}
          >
            Close
          </button>
        </div>

        <div
          className="mt-5 rounded-2xl border border-dashed border-zinc-300 bg-white p-4"
          onPaste={handleAddInfoPaste}
          tabIndex={0}
          aria-label="Paste images here"
        >
          <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
            <div className="space-y-1">
              <div className="text-sm font-medium text-zinc-900">Images (max 6)</div>
              <div className="text-xs text-zinc-600">Tip: click here and paste (Ctrl+V), or use the file picker.</div>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="addInfoFileInput"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (files.length === 0) return;
                  handleAddInfoAddFiles(files);
                }}
              />
              <button
                type="button"
                onClick={() => handleAddInfoPickFiles(document.getElementById("addInfoFileInput") as HTMLInputElement)}
                className="rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-800"
                disabled={addInfoIsSubmitting}
              >
                Upload images
              </button>
              <button
                type="button"
                onClick={resetAddInfo}
                className="rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-900 hover:bg-zinc-100"
                disabled={addInfoIsSubmitting}
              >
                Clear
              </button>
            </div>
          </div>

          {addInfoImages.length ? (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {addInfoImages.map((img) => (
                <div
                  key={img.id}
                  className="relative overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50"
                >
                  <div className="relative aspect-square">
                    <Image src={img.previewUrl} alt="Selected image" fill className="object-cover" />
                  </div>
                  <button
                    type="button"
                    onClick={() => handleAddInfoRemoveImage(img.id)}
                    className="absolute right-2 top-2 rounded-lg bg-white/90 px-2 py-1 text-xs text-zinc-900 shadow-sm hover:bg-white"
                    disabled={addInfoIsSubmitting}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-xl bg-zinc-50 px-4 py-6 text-sm text-zinc-600">
              No images yet. Paste (Ctrl+V) or click “Upload images”.
            </div>
          )}
        </div>

        <div className="mt-4 rounded-2xl border border-zinc-200 bg-white p-4">
          <label className="text-sm font-medium text-zinc-900" htmlFor="addInfoText">
            Optional text
          </label>
          <textarea
            id="addInfoText"
            value={addInfoText}
            onChange={(e) => setAddInfoText(e.target.value)}
            className="mt-2 min-h-28 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none ring-0 placeholder:text-zinc-400 focus:border-zinc-400"
            placeholder="Paste notes, LinkedIn snippet, email thread, etc."
            disabled={addInfoIsSubmitting}
          />
        </div>

        <div className="mt-4 rounded-2xl border border-zinc-200 bg-white p-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={addInfoEnableDeepResearch}
              onChange={(e) => setAddInfoEnableDeepResearch(e.target.checked)}
              className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-500"
              aria-label="Enable deep research after applying info"
              disabled={addInfoIsSubmitting}
            />
            <div>
              <div className="text-sm font-medium text-zinc-900">Run Deep Research after applying</div>
              <div className="text-xs text-zinc-600">
                Uses your existing Deep Research flow for this contact.
              </div>
            </div>
          </label>
        </div>

        {addInfoConflicts.length ? (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <div className="text-sm font-medium text-amber-900">Potential mismatch detected</div>
            <div className="mt-1 text-xs text-amber-800">
              Some extracted identifiers don’t match what’s already saved. This helps prevent duplicates.
            </div>
            <div className="mt-3 space-y-2">
              {addInfoConflicts.slice(0, 8).map((c, idx) => (
                <div key={`${c.field}-${idx}`} className="rounded-xl bg-white px-3 py-2 text-xs text-zinc-800">
                  <div className="font-medium text-zinc-900">{c.field}</div>
                  <div className="mt-1 grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-zinc-500">Existing</div>
                      <div className="truncate">{c.existing}</div>
                    </div>
                    <div>
                      <div className="text-zinc-500">Incoming</div>
                      <div className="truncate">{c.incoming}</div>
                    </div>
                  </div>
                </div>
              ))}
              {addInfoConflicts.length > 8 ? (
                <div className="text-xs text-amber-800">…and {addInfoConflicts.length - 8} more</div>
              ) : null}
            </div>
          </div>
        ) : null}

        {addInfoError ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {addInfoError}
          </div>
        ) : null}

        <div className="mt-6 flex items-center justify-end gap-2">
          {addInfoStage ? <div className="mr-auto text-xs text-zinc-600">{addInfoStage}</div> : null}
          {addInfoPendingForce ? (
            <button
              type="button"
              onClick={() => void handleSubmitAddInfo(true)}
              disabled={addInfoIsSubmitting}
              className="rounded-xl border border-amber-300 bg-amber-100 px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-200 disabled:opacity-50"
            >
              Apply anyway
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void handleSubmitAddInfo(false)}
            disabled={addInfoIsSubmitting}
            className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {addInfoIsSubmitting ? "Applying…" : "Analyze & Apply"}
          </button>
        </div>
      </div>
    </div>
  ) : null}
    </div>
  );
}


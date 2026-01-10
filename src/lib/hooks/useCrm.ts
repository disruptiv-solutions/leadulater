"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { getIdToken } from "firebase/auth";
import { useAuth } from "@/lib/hooks/useAuth";
import { db, nowServerTimestamp } from "@/lib/firebase/firestore";
import { getFirebaseAuth } from "@/lib/firebase/auth";
import type { CrmDoc, UserPrefsDoc } from "@/lib/types";

export type CrmScope = "crm" | "overview";

export type CrmRow = { id: string; data: CrmDoc };

export type UseCrmState = {
  isLoading: boolean;
  error: string | null;
  crms: CrmRow[];
  activeScope: CrmScope;
  activeCrmId: string | null;
  activeCrm: CrmRow | null;
  defaultCrmId: string | null;
  setActiveScope: (scope: CrmScope) => Promise<void>;
  setActiveCrmId: (crmId: string) => Promise<void>;
  createCrm: (name: string) => Promise<string>;
  renameCrm: (crmId: string, name: string) => Promise<void>;
};

const getTrimmedName = (value: string): string => value.trim().replace(/\s+/g, " ");

export const useCrm = (): UseCrmState => {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [prefs, setPrefs] = useState<UserPrefsDoc | null>(null);
  const [crms, setCrms] = useState<CrmRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoadingPrefs, setIsLoadingPrefs] = useState(true);
  const [isLoadingCrms, setIsLoadingCrms] = useState(true);

  const bootstrapOnceRef = useRef(false);
  const migrateOnceRef = useRef(false);

  // Ensure default CRM + prefs exist server-side (Admin) before we subscribe to client reads.
  useEffect(() => {
    if (!uid) return;
    if (bootstrapOnceRef.current) return;
    bootstrapOnceRef.current = true;

    const run = async () => {
      try {
        const auth = getFirebaseAuth();
        const currentUser = auth.currentUser;
        if (!currentUser) return;
        const idToken = await getIdToken(currentUser);

        await fetch("/api/crms/bootstrap", {
          method: "POST",
          headers: { Authorization: `Bearer ${idToken}` },
        });

        if (!migrateOnceRef.current) {
          migrateOnceRef.current = true;
          await fetch("/api/crms/migrate", {
            method: "POST",
            headers: { Authorization: `Bearer ${idToken}` },
          });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to bootstrap CRMs");
      }
    };

    void run();
  }, [uid]);

  useEffect(() => {
    if (!uid) {
      setPrefs(null);
      setIsLoadingPrefs(false);
      return;
    }

    const userRef = doc(db, "users", uid);
    const unsub = onSnapshot(
      userRef,
      (snap) => {
        setIsLoadingPrefs(false);
        setPrefs((snap.exists() ? (snap.data() as UserPrefsDoc) : null) ?? null);
      },
      (err) => {
        setIsLoadingPrefs(false);
        setPrefs(null);
        setError(err instanceof Error ? err.message : "Failed to load user prefs");
      },
    );

    return unsub;
  }, [uid]);

  const crmsQuery = useMemo(() => {
    if (!uid) {
      console.log("[useCrm] No uid, returning null query");
      return null;
    }
    const q = query(
      collection(db, "crms"),
      where("memberIds", "array-contains", uid),
      orderBy("updatedAt", "desc"),
      limit(50),
    );
    console.log("[useCrm] Created memberIds query for uid:", uid);
    return q;
  }, [uid]);

  useEffect(() => {
    console.log("[useCrm] crmsQuery effect triggered, query:", crmsQuery ? "exists" : "null");
    
    if (!crmsQuery) {
      setCrms([]);
      setIsLoadingCrms(false);
      return;
    }

    const unsub = onSnapshot(
      crmsQuery,
      (snap) => {
        console.log("[useCrm] CRMs memberIds query success, found", snap.docs.length, "CRMs");
        setIsLoadingCrms(false);
        const crmsData = snap.docs.map((d) => ({ id: d.id, data: d.data() as CrmDoc }));
        console.log("[useCrm] CRMs data:", crmsData.map(c => ({ id: c.id, name: c.data.name, memberIds: c.data.memberIds })));
        setCrms(crmsData);
        setError(null);
      },
      (err) => {
        const anyErr = err as unknown as { code?: string; message?: string; stack?: string; [key: string]: unknown };
        console.error("[useCrm] CRMs memberIds query error:", {
          code: anyErr?.code,
          message: anyErr?.message,
          error: err,
          stack: anyErr?.stack,
          fullError: JSON.stringify(err, Object.getOwnPropertyNames(err)),
          errorType: err?.constructor?.name,
          errorKeys: err && typeof err === 'object' ? Object.keys(err) : [],
        });
        
        if (anyErr?.code === "permission-denied") {
          console.error("[useCrm] Permission denied on memberIds query");
          console.error("  Current uid:", uid);
          console.error("  This means your CRMs don't have you in their memberIds arrays.");
          console.error("  SOLUTION: Click the 'Fix data' button in the CRM dropdown menu.");
          
          setIsLoadingCrms(false);
          setCrms([]);
          setError(
            `Permission denied: Your CRMs don't have you in their memberIds arrays.\n\n` +
            `SOLUTION: Click the "Fix data" button in the CRM dropdown menu to repair your data.`
          );
          return;
        }
        
        setIsLoadingCrms(false);
        setCrms([]);
        setError(err instanceof Error ? err.message : "Failed to load CRMs");
      },
    );

    return unsub;
  }, [crmsQuery, uid]);

  const activeScope: CrmScope = (prefs?.activeScope === "overview" ? "overview" : "crm") as CrmScope;
  const activeCrmId = typeof prefs?.activeCrmId === "string" && prefs.activeCrmId.trim().length
    ? prefs.activeCrmId
    : null;
  const defaultCrmId = typeof prefs?.defaultCrmId === "string" && prefs.defaultCrmId.trim().length
    ? prefs.defaultCrmId
    : null;

  const activeCrm = useMemo(() => {
    if (activeScope !== "crm") return null;
    if (!activeCrmId) return null;
    return crms.find((c) => c.id === activeCrmId) ?? null;
  }, [activeCrmId, activeScope, crms]);

  // If user is in CRM scope but has no active CRM, auto-fix to default/first.
  useEffect(() => {
    if (!uid) return;
    if (activeScope !== "crm") return;
    if (activeCrmId && activeCrm) return;
    if (!crms.length) return;

    const candidate = (defaultCrmId && crms.some((c) => c.id === defaultCrmId))
      ? defaultCrmId
      : crms[0]!.id;

    const userRef = doc(db, "users", uid);
    void setDoc(
      userRef,
      { activeCrmId: candidate, activeScope: "crm", updatedAt: nowServerTimestamp() },
      { merge: true },
    );
  }, [activeCrm, activeCrmId, activeScope, crms, defaultCrmId, uid]);

  const setActiveScope = async (scope: CrmScope) => {
    if (!uid) return;
    const userRef = doc(db, "users", uid);
    await setDoc(userRef, { activeScope: scope, updatedAt: nowServerTimestamp() }, { merge: true });
  };

  const setActiveCrmId = async (crmId: string) => {
    if (!uid) return;
    const nextId = crmId.trim();
    if (!nextId) return;
    const userRef = doc(db, "users", uid);
    await setDoc(
      userRef,
      { activeCrmId: nextId, activeScope: "crm", updatedAt: nowServerTimestamp() },
      { merge: true },
    );
  };

  const createCrm = async (name: string): Promise<string> => {
    if (!uid) throw new Error("Not authenticated");
    const trimmed = getTrimmedName(name);
    if (!trimmed) throw new Error("CRM name is required");

    const ref = await addDoc(collection(db, "crms"), {
      ownerId: uid,
      name: trimmed,
      memberIds: [uid],
      createdAt: nowServerTimestamp(),
      updatedAt: nowServerTimestamp(),
    } satisfies Omit<CrmDoc, "createdAt" | "updatedAt"> & { createdAt: unknown; updatedAt: unknown });

    const userRef = doc(db, "users", uid);
    await setDoc(
      userRef,
      { activeCrmId: ref.id, activeScope: "crm", updatedAt: nowServerTimestamp() },
      { merge: true },
    );
    return ref.id;
  };

  const renameCrm = async (crmId: string, name: string): Promise<void> => {
    if (!uid) throw new Error("Not authenticated");
    const trimmed = getTrimmedName(name);
    if (!trimmed) throw new Error("CRM name is required");
    await updateDoc(doc(db, "crms", crmId), {
      name: trimmed,
      updatedAt: nowServerTimestamp(),
    });
  };

  return {
    isLoading: isLoadingPrefs || isLoadingCrms,
    error,
    crms,
    activeScope,
    activeCrmId,
    activeCrm,
    defaultCrmId,
    setActiveScope,
    setActiveCrmId,
    createCrm,
    renameCrm,
  };
};


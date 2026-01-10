import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { getAdminApp, getAdminFirestore } from "@/lib/firebase/admin";

type RepairResult = {
  uid: string;
  activeCrmId: string | null;
  defaultCrmId: string | null;
  crmsRepaired: number;
  contactsBackfilled: number;
  capturesBackfilled: number;
  warnings: string[];
};

const uniq = (arr: string[]) => Array.from(new Set(arr));

const filterToExistingUsers = async (db: Firestore, ids: string[]) => {
  const unique = uniq(ids.filter((x) => typeof x === "string" && x.trim().length > 0));
  const results = await Promise.all(
    unique.map(async (id) => {
      const snap = await db.collection("users").doc(id).get();
      return snap.exists ? id : null;
    }),
  );
  return results.filter((x): x is string => Boolean(x));
};

const backfillCollection = async (
  db: Firestore,
  collectionName: "contacts" | "captures",
  ownerId: string,
  crmId: string,
  memberIds: string[],
) => {
  let updated = 0;
  const snap = await db.collection(collectionName).where("ownerId", "==", ownerId).get();
  if (snap.empty) return 0;

  const batch = db.batch();
  for (const docSnap of snap.docs) {
    const data = docSnap.data() as any;
    const patch: Record<string, unknown> = {};

    if (typeof data.crmId !== "string" || !data.crmId.trim()) patch.crmId = crmId;
    if (!Array.isArray(data.memberIds) || data.memberIds.length === 0) patch.memberIds = memberIds;

    if (Object.keys(patch).length) {
      patch.updatedAt = FieldValue.serverTimestamp();
      batch.set(docSnap.ref, patch, { merge: true });
      updated += 1;
    }
  }

  if (updated) await batch.commit();
  return updated;
};

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const idToken = authHeader.substring(7);
    const auth = getAuth(getAdminApp());
    const decoded = await auth.verifyIdToken(idToken);
    const uid = decoded.uid;

    const db = getAdminFirestore();
    const warnings: string[] = [];

    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const prefs = userSnap.exists ? (userSnap.data() as any) : {};

    const defaultCrmId: string | null =
      typeof prefs.defaultCrmId === "string" && prefs.defaultCrmId.trim().length
        ? prefs.defaultCrmId
        : null;

    const activeCrmId: string | null =
      typeof prefs.activeCrmId === "string" && prefs.activeCrmId.trim().length
        ? prefs.activeCrmId
        : null;

    const crmIdToUse = activeCrmId ?? defaultCrmId;
    if (!crmIdToUse) {
      return NextResponse.json({ error: "No active/default CRM to repair against" }, { status: 400 });
    }

    const crmRef = db.collection("crms").doc(crmIdToUse);
    const crmSnap = await crmRef.get();
    if (!crmSnap.exists) {
      return NextResponse.json({ error: "Active/default CRM not found" }, { status: 404 });
    }

    const crm = crmSnap.data() as any;
    const crmOwnerId: string | null = typeof crm.ownerId === "string" ? crm.ownerId : null;
    const rawMemberIds: string[] = Array.isArray(crm.memberIds) ? crm.memberIds : [];

    // Keep only memberIds that correspond to actual users docs, and always include CRM owner + current user.
    const knownUsers = await filterToExistingUsers(db, uniq([uid, ...(crmOwnerId ? [crmOwnerId] : []), ...rawMemberIds]));
    if (!knownUsers.includes(uid)) warnings.push("Current user was not in CRM memberIds; added.");
    if (crmOwnerId && !knownUsers.includes(crmOwnerId)) warnings.push("CRM ownerId did not have a users/{uid} doc; kept ownerId anyway.");

    const repairedMemberIds = uniq([...(crmOwnerId ? [crmOwnerId] : []), uid, ...knownUsers]);

    // Repair this CRM membership list.
    await crmRef.set(
      { memberIds: repairedMemberIds, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );

    // Also repair any CRMs owned by the current user (common when bad IDs got appended).
    let crmsRepaired = 1;
    const ownedCrms = await db.collection("crms").where("ownerId", "==", uid).get();
    if (!ownedCrms.empty) {
      const batch = db.batch();
      for (const c of ownedCrms.docs) {
        const data = c.data() as any;
        const mem = Array.isArray(data.memberIds) ? data.memberIds : [];
        const filtered = await filterToExistingUsers(db, mem);
        const next = uniq([uid, ...filtered]);
        batch.set(
          c.ref,
          { memberIds: next, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        crmsRepaired += 1;
      }
      await batch.commit();
    }

    // Backfill contacts/captures for this user (ensures memberIds/crmId exist).
    const [contactsBackfilled, capturesBackfilled] = await Promise.all([
      backfillCollection(db, "contacts", uid, crmIdToUse, repairedMemberIds),
      backfillCollection(db, "captures", uid, crmIdToUse, repairedMemberIds),
    ]);

    const result: RepairResult = {
      uid,
      activeCrmId,
      defaultCrmId,
      crmsRepaired,
      contactsBackfilled,
      capturesBackfilled,
      warnings,
    };
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Repair failed" },
      { status: 500 },
    );
  }
}


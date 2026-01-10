import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldPath, FieldValue, type Firestore } from "firebase-admin/firestore";
import { getAdminApp, getAdminFirestore } from "@/lib/firebase/admin";

type MigrateResult = {
  contactsUpdated: number;
  capturesUpdated: number;
  crmIdUsed: string;
};

const shouldBackfillCrmId = (data: any): boolean => typeof data?.crmId !== "string" || !data.crmId.trim();
const shouldBackfillMemberIds = (data: any): boolean => !Array.isArray(data?.memberIds) || data.memberIds.length === 0;

const migrateCollection = async (
  db: Firestore,
  collectionName: "contacts" | "captures",
  ownerId: string,
  crmId: string,
  memberIds: string[],
): Promise<number> => {
  let updated = 0;
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  while (true) {
    let q = db
      .collection(collectionName)
      .where("ownerId", "==", ownerId)
      .orderBy(FieldPath.documentId())
      .limit(400);

    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    const batch = db.batch();
    let any = false;

    for (const docSnap of snap.docs) {
      const data = docSnap.data();
      const patch: Record<string, unknown> = {};

      if (shouldBackfillCrmId(data)) patch.crmId = crmId;
      if (shouldBackfillMemberIds(data)) patch.memberIds = memberIds;

      if (Object.keys(patch).length) {
        patch.updatedAt = FieldValue.serverTimestamp();
        batch.set(docSnap.ref, patch, { merge: true });
        updated += 1;
        any = true;
      }
    }

    if (any) await batch.commit();
    lastDoc = snap.docs[snap.docs.length - 1]!;
  }

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

    const userSnap = await db.collection("users").doc(uid).get();
    const prefs = userSnap.exists ? (userSnap.data() as any) : {};

    const crmId: string | undefined =
      (typeof prefs?.defaultCrmId === "string" && prefs.defaultCrmId.trim()) ||
      (typeof prefs?.activeCrmId === "string" && prefs.activeCrmId.trim()) ||
      undefined;

    if (!crmId) {
      return NextResponse.json({ error: "No CRM found for migration" }, { status: 400 });
    }

    const crmSnap = await db.collection("crms").doc(crmId).get();
    if (!crmSnap.exists) {
      return NextResponse.json({ error: "CRM not found" }, { status: 404 });
    }
    const crm = crmSnap.data() as any;
    const memberIds = Array.isArray(crm?.memberIds) && crm.memberIds.length ? crm.memberIds : [uid];

    const [contactsUpdated, capturesUpdated] = await Promise.all([
      migrateCollection(db, "contacts", uid, crmId, memberIds),
      migrateCollection(db, "captures", uid, crmId, memberIds),
    ]);

    const result: MigrateResult = { contactsUpdated, capturesUpdated, crmIdUsed: crmId };
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Migration failed" },
      { status: 500 },
    );
  }
}


import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getAdminApp, getAdminFirestore } from "@/lib/firebase/admin";

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
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();

    const existing = userSnap.exists ? (userSnap.data() as any) : null;
    let defaultCrmId: string | null = typeof existing?.defaultCrmId === "string" ? existing.defaultCrmId : null;
    let activeCrmId: string | null = typeof existing?.activeCrmId === "string" ? existing.activeCrmId : null;
    let activeScope: "crm" | "overview" = existing?.activeScope === "overview" ? "overview" : "crm";

    if (defaultCrmId) {
      const crmSnap = await db.collection("crms").doc(defaultCrmId).get();
      if (!crmSnap.exists) {
        defaultCrmId = null;
      }
    }

    if (!defaultCrmId) {
      const crmRef = db.collection("crms").doc();
      defaultCrmId = crmRef.id;

      await crmRef.set({
        ownerId: uid,
        name: "Business 1",
        memberIds: [uid],
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      activeCrmId = defaultCrmId;
      activeScope = "crm";
    }

    if (!activeCrmId) {
      activeCrmId = defaultCrmId;
    }

    await userRef.set(
      {
        defaultCrmId,
        activeCrmId,
        activeScope,
        ...(userSnap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return NextResponse.json({ defaultCrmId, activeCrmId, activeScope });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Bootstrap failed" },
      { status: 500 },
    );
  }
}


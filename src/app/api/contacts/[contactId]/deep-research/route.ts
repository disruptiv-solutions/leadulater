import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminApp, getAdminFirestore } from "@/lib/firebase/admin";
import { performDeepResearch } from "@/lib/perplexity";
import { buildEnrichmentSystemPrompt, contactEnrichmentSchema } from "@/lib/enrichmentSchema";
import { getOpenRouterConfig, openRouterChat } from "@/lib/openrouter";
import { safeParseModelJson } from "@/lib/extractionSchema";
import { persistResearchImages } from "@/app/api/_utils/researchImages";
import { normalizeUrl } from "@/app/api/_utils/researchImages";
import { curateExtraLinks } from "@/app/api/_utils/curateExtraLinks";
import { mergeSocialFollowers } from "@/app/api/_utils/socialFollowers";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ contactId: string }> },
) {
  try {
    // TODO: add streaming mode (concise) to stream reasoning + content to the client.
    const { contactId } = await context.params;

    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const idToken = authHeader.substring(7);

    const auth = getAuth(getAdminApp());
    const decoded = await auth.verifyIdToken(idToken);
    const ownerId = decoded.uid;

    const db = getAdminFirestore();
    const contactRef = db.collection("contacts").doc(contactId);
    const snap = await contactRef.get();
    if (!snap.exists) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const data = snap.data() as any;
    const memberIds = Array.isArray(data.memberIds) ? data.memberIds : [];
    const canAccess = data.ownerId === ownerId || memberIds.includes(ownerId);
    if (!canAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await contactRef.set(
      {
        deepResearchStatus: "running",
        deepResearchError: null,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    const research = await performDeepResearch({
      fullName: data.fullName ?? null,
      firstName: data.firstName ?? null,
      lastName: data.lastName ?? null,
      companyName: data.companyName ?? null,
      email: data.email ?? null,
      linkedInUrl: data.linkedInUrl ?? null,
      website: data.website ?? null,
      jobTitle: data.jobTitle ?? null,
      location: data.location ?? null,
    });

    const persistedImages = await persistResearchImages({
      ownerId: data.ownerId,
      contactId,
      images: research.images ?? [],
      maxImages: 6,
    });

    await contactRef.set(
      {
        deepResearchRaw: research.content,
        researchImages: persistedImages,
        deepResearchSources: research.search_results ?? [],
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    const enrichmentSystem = buildEnrichmentSystemPrompt();
    const enrichmentUser = [
      "Current contact JSON:",
      JSON.stringify(data, null, 2),
      "",
      "Deep research text (with citations):",
      research.content,
    ].join("\n\n");

    const { model } = getOpenRouterConfig();
    const enrichmentContent = await openRouterChat({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: enrichmentSystem },
        { role: "user", content: enrichmentUser },
      ],
    });

    const enrichmentJson = safeParseModelJson(enrichmentContent);
    const enrichment = contactEnrichmentSchema.parse(enrichmentJson);

    const patch = enrichment.contactPatch ?? {};
    const tags = Array.isArray(patch.tags)
      ? Array.from(new Set(patch.tags.map((t) => `${t}`.trim()).filter(Boolean)))
      : undefined;

    const summary = typeof enrichment.summary === "string" ? enrichment.summary.trim() : "";
    const summaryOrNull = summary.length ? summary : null;

    const extraLinks = (enrichment.extraLinks ?? [])
      .map((l) => ({ label: `${l.label}`.trim(), url: normalizeUrl(l.url) }))
      .filter((l): l is { label: string; url: string } => Boolean(l.url) && l.label.length > 0);

    // Reconcile links: Perplexity sources + URLs in research text + enrichment + existing.
    const curatedLinks = await curateExtraLinks({
      contact: {
        fullName: data.fullName ?? null,
        firstName: data.firstName ?? null,
        lastName: data.lastName ?? null,
        companyName: data.companyName ?? null,
        email: data.email ?? null,
        linkedInUrl: data.linkedInUrl ?? null,
        website: data.website ?? null,
      },
      researchText: research.content ?? "",
      sources: (research.search_results ?? []) as any,
      enrichmentExtraLinks: extraLinks,
      existingExtraLinks: Array.isArray(data.extraLinks) ? data.extraLinks : [],
      maxLinks: 12,
    });

    const notesValue = patch.notes !== undefined ? patch.notes : summaryOrNull;
    const mergedFollowers = mergeSocialFollowers(data.socialFollowers, enrichment.socialFollowers);

    await contactRef.set(
      {
        ...(patch.fullName !== undefined ? { fullName: patch.fullName } : {}),
        ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
        ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
        ...(patch.jobTitle !== undefined ? { jobTitle: patch.jobTitle } : {}),
        ...(patch.companyName !== undefined ? { companyName: patch.companyName } : {}),
        ...(patch.email !== undefined ? { email: patch.email } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.linkedInUrl !== undefined ? { linkedInUrl: patch.linkedInUrl } : {}),
        ...(patch.website !== undefined ? { website: patch.website } : {}),
        ...(patch.location !== undefined ? { location: patch.location } : {}),
        ...(notesValue !== undefined ? { notes: notesValue } : {}),
        ...(tags !== undefined ? { tags } : {}),

        deepResearchSummary: summaryOrNull,
        researchFields: enrichment.researchFields ?? {},
        ...(mergedFollowers ? { socialFollowers: mergedFollowers } : {}),
        extraLinks: curatedLinks,
        deepResearchStatus: "done",
        deepResearchError: null,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Deep research failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}


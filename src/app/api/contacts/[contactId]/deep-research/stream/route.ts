import { NextRequest } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminApp, getAdminFirestore } from "@/lib/firebase/admin";
import { persistResearchImages } from "@/app/api/_utils/researchImages";
import { normalizeUrl } from "@/app/api/_utils/researchImages";
import { buildEnrichmentSystemPrompt, contactEnrichmentSchema } from "@/lib/enrichmentSchema";
import { getOpenRouterConfig, openRouterChat } from "@/lib/openrouter";
import { safeParseModelJson } from "@/lib/extractionSchema";
import { curateExtraLinks } from "@/app/api/_utils/curateExtraLinks";
import { mergeSocialFollowers } from "@/app/api/_utils/socialFollowers";

type NDJsonEvent =
  | { type: "reasoning"; text: string }
  | { type: "content"; text: string }
  | { type: "sources"; sources: Array<{ title?: string; url?: string; date?: string }> }
  | { type: "status"; stage: string }
  | { type: "done"; ok: true }
  | { type: "error"; message: string };

const encode = (e: NDJsonEvent): Uint8Array => {
  return new TextEncoder().encode(`${JSON.stringify(e)}\n`);
};

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ contactId: string }> },
) {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const { contactId } = await context.params;

        const authHeader = request.headers.get("authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          controller.enqueue(encode({ type: "error", message: "Unauthorized" }));
          controller.close();
          return;
        }
        const idToken = authHeader.substring(7);

        const auth = getAuth(getAdminApp());
        const decoded = await auth.verifyIdToken(idToken);
        const ownerId = decoded.uid;

        const db = getAdminFirestore();
        const contactRef = db.collection("contacts").doc(contactId);
        const snap = await contactRef.get();
        if (!snap.exists) {
          controller.enqueue(encode({ type: "error", message: "Not found" }));
          controller.close();
          return;
        }

        const data = snap.data() as any;
        const memberIds = Array.isArray(data.memberIds) ? data.memberIds : [];
        const canAccess = data.ownerId === ownerId || memberIds.includes(ownerId);
        if (!canAccess) {
          controller.enqueue(encode({ type: "error", message: "Forbidden" }));
          controller.close();
          return;
        }

        controller.enqueue(encode({ type: "status", stage: "starting" }));

        await contactRef.set(
          {
            deepResearchStatus: "running",
            deepResearchError: null,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        controller.enqueue(encode({ type: "status", stage: "searching" }));

        let fullContent = "";
        let images: any[] = [];
        let searchResults: any[] = [];

        // Dynamic import to avoid Turbopack export-shape caching issues.
        const perplexityMod: any = await import("@/lib/perplexity");
        const streamFn = perplexityMod?.streamDeepResearchConcise;
        const performFn = perplexityMod?.performDeepResearch;

        if (typeof streamFn === "function") {
          const perplexityStream = await streamFn({
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

          for await (const chunk of perplexityStream as AsyncIterable<any>) {
            const obj = chunk?.object as string | undefined;

            if (obj === "chat.reasoning") {
              const steps = chunk?.choices?.[0]?.delta?.reasoning_steps;
              if (Array.isArray(steps)) {
                for (const s of steps) {
                  const thought = s?.thought;
                  if (typeof thought === "string" && thought.trim().length) {
                    controller.enqueue(encode({ type: "reasoning", text: thought }));
                  }
                }
              }
            }

            if (obj === "chat.reasoning.done") {
              controller.enqueue(encode({ type: "status", stage: "generating" }));
              if (Array.isArray(chunk?.images)) images = chunk.images;
              if (Array.isArray(chunk?.search_results)) {
                searchResults = chunk.search_results;
                controller.enqueue(encode({ type: "sources", sources: searchResults }));
              }
            }

            if (obj === "chat.completion.chunk") {
              const delta = chunk?.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta.length) {
                fullContent += delta;
                controller.enqueue(encode({ type: "content", text: delta }));
              }
            }

            if (obj === "chat.completion.done") {
              const final = chunk?.choices?.[0]?.message?.content;
              if (typeof final === "string" && final.trim().length) {
                fullContent = final;
              }
              if (Array.isArray(chunk?.images)) images = chunk.images;
              if (Array.isArray(chunk?.search_results)) {
                searchResults = chunk.search_results;
                controller.enqueue(encode({ type: "sources", sources: searchResults }));
              }
            }
          }
        } else if (typeof performFn === "function") {
          // Fallback: non-streaming deep research (still works).
          controller.enqueue(encode({ type: "status", stage: "generating" }));
          const res = await performFn({
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

          fullContent = res?.content ?? "";
          images = res?.images ?? [];
          searchResults = res?.search_results ?? [];
          if (Array.isArray(searchResults) && searchResults.length) {
            controller.enqueue(encode({ type: "sources", sources: searchResults }));
          }
          if (fullContent) controller.enqueue(encode({ type: "content", text: fullContent }));
        } else {
          throw new Error("Perplexity module did not export expected functions");
        }

        controller.enqueue(encode({ type: "status", stage: "saving" }));

        const persistedImages = await persistResearchImages({
          ownerId: data.ownerId,
          contactId,
          images,
          maxImages: 6,
        });

        await contactRef.set(
          {
            deepResearchRaw: fullContent,
            researchImages: persistedImages,
            deepResearchSources: Array.isArray(searchResults) ? searchResults : [],
            // storing search results is optional but helpful for debugging later
            deepResearchPrompt: "Deep research requested (streamed).",
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        // Enrichment pass (clean patch + dynamic fields)
        controller.enqueue(encode({ type: "status", stage: "enriching" }));

        const enrichmentSystem = buildEnrichmentSystemPrompt();
        const enrichmentUser = [
          "Current contact JSON:",
          JSON.stringify(data, null, 2),
          "",
          "Deep research text (with citations):",
          fullContent,
          "",
          "Search results metadata (titles only):",
          Array.isArray(searchResults)
            ? searchResults.map((r: any) => `- ${r?.title ?? "(untitled)"}`).join("\n")
            : "(none)",
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

        // Reconcile links after enrichment: Perplexity sources + URLs in research text + enrichment + existing.
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
          researchText: fullContent ?? "",
          sources: (Array.isArray(searchResults) ? searchResults : []) as any,
          enrichmentExtraLinks: extraLinks,
          existingExtraLinks: Array.isArray(data.extraLinks) ? data.extraLinks : [],
          maxLinks: 12,
        });

        // If the model didn't set notes explicitly, use summary as the contact's Notes.
        const notesValue =
          patch.notes !== undefined ? patch.notes : summaryOrNull;

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

        controller.enqueue(encode({ type: "done", ok: true }));
        controller.close();
      } catch (err) {
        controller.enqueue(
          encode({
            type: "error",
            message: err instanceof Error ? err.message : "Deep research stream failed",
          }),
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}


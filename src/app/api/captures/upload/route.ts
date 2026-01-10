import { NextRequest, NextResponse } from "next/server";
import { getAdminStorage, getAdminFirestore, getAdminApp } from "@/lib/firebase/admin";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, type Firestore, type DocumentReference } from "firebase-admin/firestore";
import type { CaptureDoc } from "@/lib/types";
import { getOpenRouterConfig, openRouterChat } from "@/lib/openrouter";
import { contactExtractionSchema, buildExtractionSystemPrompt, safeParseModelJson } from "@/lib/extractionSchema";
import { performDeepResearch } from "@/lib/perplexity";
import { buildEnrichmentSystemPrompt, contactEnrichmentSchema } from "@/lib/enrichmentSchema";
import { persistResearchImages } from "@/app/api/_utils/researchImages";
import { normalizeUrl } from "@/app/api/_utils/researchImages";

const allowedImageMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

const getImageExtension = (mimeType: string): string => {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/jpeg") return "jpg";
  return "bin";
};

const toDataUrl = (mimeType: string, bytes: Buffer): string => {
  const base64 = bytes.toString("base64");
  return `data:${mimeType};base64,${base64}`;
};

const MAX_IMAGES = 6;
const MAX_BYTES_PER_IMAGE = 10 * 1024 * 1024; // 10MB

export async function POST(request: NextRequest) {
  try {
    // Get auth token from header
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const idToken = authHeader.substring(7);

    // Verify token and get user ID
    const auth = getAuth(getAdminApp());
    const decodedToken = await auth.verifyIdToken(idToken);
    const ownerId = decodedToken.uid;

    const formData = await request.formData();
    const crmId = (formData.get("crmId") as string | null)?.trim() || "";
    const text = (formData.get("text") as string | null) || "";
    const enableDeepResearch = formData.get("enableDeepResearch") === "true";

    // Verify ownerId matches token
    const formOwnerId = formData.get("ownerId") as string | null;
    if (formOwnerId && formOwnerId !== ownerId) {
      return NextResponse.json({ error: "Owner ID mismatch" }, { status: 403 });
    }

    if (!crmId) {
      return NextResponse.json({ error: "Missing crmId" }, { status: 400 });
    }

    // Get all image files (optional)
    const imageFiles: File[] = [];
    for (let i = 1; i <= MAX_IMAGES; i++) {
      const file = formData.get(`image${i}`) as File | null;
      if (file && file.size > 0) {
        imageFiles.push(file);
      }
    }

    // Require at least images or text
    if (imageFiles.length === 0 && !text.trim()) {
      return NextResponse.json(
        { error: "Please provide at least one image or some text" },
        { status: 400 },
      );
    }

    if (imageFiles.length > MAX_IMAGES) {
      return NextResponse.json({ error: `Max ${MAX_IMAGES} images allowed` }, { status: 400 });
    }

    // Validate images (if any)
    for (const file of imageFiles) {
      if (!allowedImageMimeTypes.has(file.type)) {
        return NextResponse.json(
          { error: `Unsupported image type: ${file.type || "unknown"}` },
          { status: 400 },
        );
      }
      if (file.size > MAX_BYTES_PER_IMAGE) {
        return NextResponse.json(
          { error: `Image too large (max ${Math.round(MAX_BYTES_PER_IMAGE / 1024 / 1024)}MB)` },
          { status: 400 },
        );
      }
    }

    // Create capture document ID
    const db = getAdminFirestore();

    // Validate CRM membership (shared CRM support)
    const crmRef = db.collection("crms").doc(crmId);
    const crmSnap = await crmRef.get();
    if (!crmSnap.exists) {
      return NextResponse.json({ error: "CRM not found" }, { status: 404 });
    }
    const crmData = crmSnap.data() as { memberIds?: string[] } | undefined;
    const memberIds = Array.isArray(crmData?.memberIds) ? crmData!.memberIds : [];
    if (!memberIds.includes(ownerId)) {
      return NextResponse.json({ error: "Not a member of this CRM" }, { status: 403 });
    }

    const captureRef = db.collection("captures").doc();
    const captureId = captureRef.id;

    // Upload images to Storage (if any)
    const storage = getAdminStorage();
    const bucket = storage.bucket();
    const imagePaths: string[] = [];

    if (imageFiles.length > 0) {
      for (let idx = 0; idx < imageFiles.length; idx++) {
        const file = imageFiles[idx]!;
        const ext = getImageExtension(file.type);
        const storagePath = `users/${ownerId}/captures/${captureId}/img_${idx + 1}.${ext}`;
        
        const buffer = Buffer.from(await file.arrayBuffer());
        const storageFile = bucket.file(storagePath);
        
        await storageFile.save(buffer, {
          metadata: {
            contentType: file.type,
          },
        });

        imagePaths.push(storagePath);
      }
    }

    // Create capture document with "processing" status
    const captureDoc: CaptureDoc = {
      ownerId,
      crmId,
      memberIds,
      status: "processing",
      text,
      imagePaths,
      createdAt: FieldValue.serverTimestamp() as any,
      updatedAt: FieldValue.serverTimestamp() as any,
      deepResearchEnabled: enableDeepResearch,
    };

    await captureRef.set(captureDoc);

    // Process with OpenRouter in the background
    // We'll update the capture status when done
    processCaptureAsync(
      captureId,
      ownerId,
      crmId,
      memberIds,
      text,
      imageFiles,
      imagePaths,
      captureRef,
      db,
      enableDeepResearch,
    ).catch((err) => {
      console.error("Background processing error:", err);
      captureRef.set(
        {
          status: "error",
          error: err instanceof Error ? err.message : "Processing failed",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });

    return NextResponse.json({
      captureId,
      imagePaths,
    });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 },
    );
  }
}

async function processCaptureAsync(
  captureId: string,
  ownerId: string,
  crmId: string,
  memberIds: string[],
  text: string,
  imageFiles: File[],
  imagePaths: string[],
  captureRef: DocumentReference,
  db: Firestore,
  enableDeepResearch: boolean,
) {
  try {
    // Convert images to base64 data URLs (if any)
    const imageParts = imageFiles.length > 0
      ? await Promise.all(
          imageFiles.map(async (file) => {
            const buffer = Buffer.from(await file.arrayBuffer());
            return {
              type: "image_url" as const,
              image_url: { url: toDataUrl(file.type, buffer) },
            };
          }),
        )
      : [];

    // Build OpenRouter request
    const systemPrompt = buildExtractionSystemPrompt();
    const hasImages = imageParts.length > 0;
    const hasText = text.trim().length > 0;
    
    let userText: string;
    if (hasImages && hasText) {
      userText = [
        "Extract a lead/contact from the pasted text and the images.",
        "If you infer something from images, state evidence like 'screenshot #N'.",
        "Pasted text:",
        text.trim(),
      ].join("\n\n");
    } else if (hasImages) {
      userText = [
        "Extract a lead/contact from the images.",
        "State evidence like 'screenshot #N' for any fields you extract.",
      ].join("\n\n");
    } else {
      userText = [
        "Extract a lead/contact from the pasted text.",
        text.trim(),
      ].join("\n\n");
    }

    const { model } = getOpenRouterConfig();
    const content = await openRouterChat({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: imageParts.length > 0
            ? [
                { type: "text", text: userText },
                ...imageParts,
              ]
            : userText,
        },
      ],
    });

    // Parse JSON response
    let parsedJson: unknown;
    try {
      parsedJson = safeParseModelJson(content);
    } catch (err) {
      // One repair retry
      const repair = await openRouterChat({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: "Return ONLY valid JSON. No markdown." },
          {
            role: "user",
            content: [
              "Fix this into valid JSON that matches the required schema. Return JSON only.",
              "Invalid output:",
              content,
            ].join("\n\n"),
          },
        ],
      });
      parsedJson = safeParseModelJson(repair);
    }

    const extraction = contactExtractionSchema.parse(parsedJson);

    // Create contact document
    const contactRef = db.collection("contacts").doc();
    const contactId = contactRef.id;

    const contact = extraction.contact ?? {};
    const tags = Array.isArray(contact.tags)
      ? Array.from(new Set(contact.tags.map((t) => `${t}`.trim()).filter(Boolean)))
      : [];

    await contactRef.set({
      ownerId,
      crmId,
      memberIds,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      isDraft: true,
      sourceCaptureId: captureId,

      fullName: contact.fullName ?? null,
      firstName: contact.firstName ?? null,
      lastName: contact.lastName ?? null,
      jobTitle: contact.jobTitle ?? null,
      companyName: contact.companyName ?? null,
      email: contact.email ?? null,
      phone: contact.phone ?? null,
      linkedInUrl: contact.linkedInUrl ?? null,
      website: contact.website ?? null,
      location: contact.location ?? null,
      notes: contact.notes ?? null,
      tags,

      ai: {
        confidenceByField: extraction.confidenceByField ?? {},
        evidence: extraction.evidence ?? {},
      },

      deepResearchStatus: enableDeepResearch ? "queued" : "disabled",
    });

    // If deep research is enabled, keep capture in a visible "researching" state until enrichment completes.
    // Otherwise mark ready immediately.
    await captureRef.set(
      {
        status: enableDeepResearch ? "researching" : "ready",
        resultContactId: contactId,
        rawExtraction: parsedJson,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // Perform deep research if enabled
    if (enableDeepResearch) {
      try {
        // Store prompt + status so UI can show progress.
        const researchPrompt = "Deep research requested via Quick Capture.";
        await contactRef.set(
          {
            deepResearchStatus: "running",
            deepResearchPrompt: researchPrompt,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        const research = await performDeepResearch({
          fullName: contact.fullName,
          firstName: contact.firstName,
          lastName: contact.lastName,
          companyName: contact.companyName,
          email: contact.email,
          linkedInUrl: contact.linkedInUrl,
          website: contact.website,
          jobTitle: contact.jobTitle,
          location: contact.location,
        });

        const persistedImages = await persistResearchImages({
          ownerId,
          contactId,
          images: research.images ?? [],
          maxImages: 6,
        });

        await contactRef.set(
          {
            deepResearchRaw: research.content,
            researchImages: persistedImages,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        // Second pass: turn research into clean patches + dynamic fields.
        const enrichmentSystem = buildEnrichmentSystemPrompt();
        const enrichmentUser = [
          "Initial extracted contact JSON:",
          JSON.stringify(extraction, null, 2),
          "",
          "Deep research text (with citations):",
          research.content,
        ].join("\n\n");

        const { model: enrichModel } = getOpenRouterConfig();
        const enrichmentContent = await openRouterChat({
          model: enrichModel,
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

        const notesValue = patch.notes !== undefined ? patch.notes : summaryOrNull;

        await contactRef.set(
          {
            // Apply patch fields if present
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
            extraLinks,
            deepResearchStatus: "done",
            deepResearchError: null,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        // Now mark capture as ready (this triggers redirect on the capture progress page).
        await captureRef.set(
          {
            status: "ready",
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      } catch (researchErr) {
        await contactRef.set(
          {
            deepResearchStatus: "error",
            deepResearchError: researchErr instanceof Error ? researchErr.message : "Deep research failed",
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        // Even if research fails, unblock the user by marking capture ready.
        await captureRef.set(
          {
            status: "ready",
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Processing failed";
    console.error("processCaptureAsync error:", message);
    throw err;
  }
}

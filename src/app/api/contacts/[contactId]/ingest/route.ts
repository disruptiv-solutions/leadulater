import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminApp, getAdminFirestore } from "@/lib/firebase/admin";
import { getOpenRouterConfig, openRouterChat } from "@/lib/openrouter";
import { contactExtractionSchema, buildExtractionSystemPrompt, safeParseModelJson } from "@/lib/extractionSchema";
import { mergeSocialFollowers } from "@/app/api/_utils/socialFollowers";

const allowedImageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGES = 6;
const MAX_BYTES_PER_IMAGE = 10 * 1024 * 1024; // 10MB

const toDataUrl = (mimeType: string, bytes: Buffer): string => {
  const base64 = bytes.toString("base64");
  return `data:${mimeType};base64,${base64}`;
};

const normalizeEmail = (v: unknown): string => `${v ?? ""}`.trim().toLowerCase();
const normalizePhone = (v: unknown): string => `${v ?? ""}`.replace(/[^\d+]/g, "");
const normalizeName = (v: unknown): string => `${v ?? ""}`.trim().toLowerCase().replace(/\s+/g, " ");
const normalizeUrl = (v: unknown): string => `${v ?? ""}`.trim().toLowerCase();

type Conflict = { field: string; existing: string; incoming: string };

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ contactId: string }> },
) {
  try {
    const { contactId } = await context.params;

    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const idToken = authHeader.substring(7);

    const auth = getAuth(getAdminApp());
    const decoded = await auth.verifyIdToken(idToken);
    const ownerId = decoded.uid;

    const formData = await request.formData();
    const text = (formData.get("text") as string | null) || "";
    const enableDeepResearch = formData.get("enableDeepResearch") === "true";
    const force = formData.get("force") === "true";

    // Get all image files (optional)
    const imageFiles: File[] = [];
    for (let i = 1; i <= MAX_IMAGES; i++) {
      const file = formData.get(`image${i}`) as File | null;
      if (file && file.size > 0) imageFiles.push(file);
    }

    if (imageFiles.length === 0 && !text.trim()) {
      return NextResponse.json(
        { error: "Please provide at least one image or some text" },
        { status: 400 },
      );
    }

    if (imageFiles.length > MAX_IMAGES) {
      return NextResponse.json({ error: `Max ${MAX_IMAGES} images allowed` }, { status: 400 });
    }

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

    const db = getAdminFirestore();
    const contactRef = db.collection("contacts").doc(contactId);
    const snap = await contactRef.get();
    if (!snap.exists) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const existing = snap.data() as any;
    const memberIds = Array.isArray(existing.memberIds) ? existing.memberIds : [];
    const canEdit = existing.ownerId === ownerId || memberIds.includes(ownerId);
    if (!canEdit) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Convert images to base64 data URLs (if any)
    const imageParts =
      imageFiles.length > 0
        ? await Promise.all(
            imageFiles.map(async (file) => {
              const buffer = Buffer.from(await file.arrayBuffer());
              return { type: "image_url" as const, image_url: { url: toDataUrl(file.type, buffer) } };
            }),
          )
        : [];

    const systemPrompt = buildExtractionSystemPrompt();
    const userText = [
      "You are adding new information to an existing CRM contact record.",
      "Only extract details that clearly refer to the SAME person/company as the existing contact.",
      "If the incoming info appears to be for a different person (different email/phone/name), still extract what you see, but do NOT invent reconciliations.",
      "",
      "Existing contact JSON:",
      JSON.stringify(
        {
          fullName: existing.fullName ?? null,
          firstName: existing.firstName ?? null,
          lastName: existing.lastName ?? null,
          email: existing.email ?? null,
          phone: existing.phone ?? null,
          companyName: existing.companyName ?? null,
          jobTitle: existing.jobTitle ?? null,
          linkedInUrl: existing.linkedInUrl ?? null,
          website: existing.website ?? null,
          location: existing.location ?? null,
          notes: existing.notes ?? null,
          tags: existing.tags ?? [],
        },
        null,
        2,
      ),
      "",
      text.trim().length ? ["New pasted text:", text.trim()].join("\n") : "New pasted text: (none)",
      "",
      "Task: Extract any contact fields from the NEW info (text/images). Return JSON ONLY.",
    ].join("\n\n");

    const { model } = getOpenRouterConfig();
    const content = await openRouterChat({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: imageParts.length > 0 ? [{ type: "text", text: userText }, ...imageParts] : userText,
        },
      ],
    });

    // Parse JSON response with one repair retry
    let parsedJson: unknown;
    try {
      parsedJson = safeParseModelJson(content);
    } catch {
      const repair = await openRouterChat({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: "Return ONLY valid JSON. No markdown." },
          {
            role: "user",
            content: ["Fix this into valid JSON that matches the required schema. Return JSON only.", "Invalid output:", content].join(
              "\n\n",
            ),
          },
        ],
      });
      parsedJson = safeParseModelJson(repair);
    }

    const extraction = contactExtractionSchema.parse(parsedJson);
    const incoming = extraction.contact ?? {};

    // Detect conflicts (dedupe guardrail)
    const conflicts: Conflict[] = [];

    const exEmail = normalizeEmail(existing.email);
    const inEmail = normalizeEmail(incoming.email);
    if (exEmail && inEmail && exEmail !== inEmail) {
      conflicts.push({ field: "email", existing: existing.email ?? "", incoming: incoming.email ?? "" });
    }

    const exPhone = normalizePhone(existing.phone);
    const inPhone = normalizePhone(incoming.phone);
    if (exPhone && inPhone && exPhone !== inPhone) {
      conflicts.push({ field: "phone", existing: existing.phone ?? "", incoming: incoming.phone ?? "" });
    }

    const exName = normalizeName(existing.fullName || `${existing.firstName ?? ""} ${existing.lastName ?? ""}`.trim());
    const inName = normalizeName(incoming.fullName || `${incoming.firstName ?? ""} ${incoming.lastName ?? ""}`.trim());
    if (exName && inName && exName !== inName) {
      conflicts.push({ field: "name", existing: exName, incoming: inName });
    }

    const exLinkedIn = normalizeUrl(existing.linkedInUrl);
    const inLinkedIn = normalizeUrl(incoming.linkedInUrl);
    if (exLinkedIn && inLinkedIn && exLinkedIn !== inLinkedIn) {
      conflicts.push({
        field: "linkedInUrl",
        existing: existing.linkedInUrl ?? "",
        incoming: incoming.linkedInUrl ?? "",
      });
    }

    if (conflicts.length > 0 && !force) {
      return NextResponse.json(
        { error: "Conflicts detected", conflicts },
        { status: 409 },
      );
    }

    // Apply patch safely (fill blanks; overwrite only when force=true)
    const patch: Record<string, unknown> = {};
    const appliedFields: string[] = [];

    const applyField = (key: string, value: unknown, normalize: (v: unknown) => string) => {
      const v = typeof value === "string" ? value.trim() : value;
      if (!v || (typeof v === "string" && v.trim().length === 0)) return;
      const existingValue = existing?.[key];
      const ex = normalize(existingValue);
      const inc = normalize(v);
      if (!ex) {
        patch[key] = v;
        appliedFields.push(key);
        return;
      }
      if (ex === inc) return;
      if (force) {
        patch[key] = v;
        appliedFields.push(key);
      }
    };

    applyField("fullName", incoming.fullName, normalizeName);
    applyField("firstName", incoming.firstName, normalizeName);
    applyField("lastName", incoming.lastName, normalizeName);
    applyField("jobTitle", incoming.jobTitle, normalizeName);
    applyField("companyName", incoming.companyName, normalizeName);
    applyField("email", incoming.email, normalizeEmail);
    applyField("phone", incoming.phone, normalizePhone);
    applyField("linkedInUrl", incoming.linkedInUrl, normalizeUrl);
    applyField("website", incoming.website, normalizeUrl);
    applyField("location", incoming.location, normalizeName);

    // Notes: append rather than overwrite (unless force and empty)
    const incomingNotes = typeof incoming.notes === "string" ? incoming.notes.trim() : "";
    if (incomingNotes.length) {
      const existingNotes = typeof existing.notes === "string" ? existing.notes.trim() : "";
      const nextNotes = existingNotes.length
        ? `${existingNotes}\n\n[Added info]\n${incomingNotes}`
        : incomingNotes;
      patch.notes = nextNotes;
      appliedFields.push("notes");
    }

    // Tags: union
    const inTags = Array.isArray(incoming.tags) ? incoming.tags.map((t) => `${t}`.trim()).filter(Boolean) : [];
    if (inTags.length) {
      const existingTags = Array.isArray(existing.tags) ? existing.tags.map((t: any) => `${t}`.trim()).filter(Boolean) : [];
      const merged = Array.from(new Set([...existingTags, ...inTags]));
      patch.tags = merged;
      appliedFields.push("tags");
    }

    // Social followers: merge/dedupe (keep highest count per platform)
    const mergedFollowers = mergeSocialFollowers(existing.socialFollowers, (incoming as any).socialFollowers);
    if (mergedFollowers) {
      patch.socialFollowers = mergedFollowers;
      appliedFields.push("socialFollowers");
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({
        success: true,
        appliedFields: [],
        deepResearchQueued: enableDeepResearch,
        message: "No new fields to apply.",
      });
    }

    patch.updatedAt = FieldValue.serverTimestamp();
    if (enableDeepResearch) {
      patch.deepResearchStatus = "queued";
      patch.deepResearchError = null;
    }

    await contactRef.set(patch, { merge: true });

    return NextResponse.json({
      success: true,
      appliedFields,
      deepResearchQueued: enableDeepResearch,
      message: "Info applied.",
    });
  } catch (error) {
    console.error("Contact ingest error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Ingest failed" },
      { status: 500 },
    );
  }
}


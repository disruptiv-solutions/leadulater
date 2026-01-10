import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import { config } from "dotenv";
import { resolve } from "path";
import { contactExtractionSchema, buildExtractionSystemPrompt, safeParseModelJson } from "./extractionSchema";
import { getOpenRouterConfig, openRouterChat } from "./openrouter";

// Load .env.local from root directory for local development
// This runs when the function code loads (both in emulator and deployed)
// For emulator: process.cwd() is functions/, so go up one level
// For deployed: secrets are used, but this won't hurt
try {
  const rootEnvPath = resolve(__dirname, "../../.env.local");
  config({ path: rootEnvPath });
} catch {
  // Ignore if .env.local doesn't exist (deployed functions use secrets)
}

initializeApp();

const db = getFirestore();
const storage = getStorage();

type CaptureDoc = {
  ownerId: string;
  status: "queued" | "processing" | "ready" | "error";
  text?: string;
  imagePaths?: string[];
  createdAt?: FirebaseFirestore.Timestamp;
  updatedAt?: FirebaseFirestore.Timestamp;
  error?: string;
  resultContactId?: string;
  rawExtraction?: unknown;
  imagesDeletedAt?: FirebaseFirestore.Timestamp;
};

const toDataUrl = (mimeType: string, bytes: Buffer): string => {
  const base64 = bytes.toString("base64");
  return `data:${mimeType};base64,${base64}`;
};

const guessMimeTypeFromPath = (path: string): string => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
};

export const processCaptureOnCreate = onDocumentCreated(
  {
    document: "captures/{captureId}",
    region: "us-central1",
    // Only use secrets in production; local dev uses .env.local
    secrets: process.env.NODE_ENV === "production" ? ["OPENROUTER_API_KEY"] : undefined,
  },
  async (event) => {
    const captureId = event.params.captureId as string;
    const snap = event.data;
    if (!snap) return;

    const capture = snap.data() as CaptureDoc;
    const ownerId = capture.ownerId;

    const captureRef = db.collection("captures").doc(captureId);

    if (!ownerId) {
      await captureRef.set(
        {
          status: "error",
          error: "Missing ownerId",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return;
    }

    // Mark as processing
    await captureRef.set(
      {
        status: "processing",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    try {
      const imagePaths = (capture.imagePaths ?? []).slice(0, 6);
      const bucket = storage.bucket();

      const imageParts = await Promise.all(
        imagePaths.map(async (path, idx) => {
          const file = bucket.file(path);
          const [bytes] = await file.download();
          const mime = guessMimeTypeFromPath(path);
          return {
            type: "image_url" as const,
            image_url: { url: toDataUrl(mime, bytes) },
            _idx: idx,
          };
        }),
      );

      const systemPrompt = buildExtractionSystemPrompt();
      const userText = [
        "Extract a lead/contact from the pasted text and the images.",
        "If you infer something from images, state evidence like 'screenshot #N'.",
        "Pasted text:",
        (capture.text ?? "").trim() || "(none)",
      ].join("\n\n");

      const { model } = getOpenRouterConfig();
      const content = await openRouterChat({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: userText },
              ...imageParts
                .sort((a, b) => a._idx - b._idx)
                .map(({ _idx, ...rest }) => rest),
            ],
          },
        ],
      });

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

      const contactRef = db.collection("contacts").doc();
      const contactId = contactRef.id;

      const contact = extraction.contact ?? {};
      const tags = Array.isArray(contact.tags)
        ? Array.from(new Set(contact.tags.map((t) => `${t}`.trim()).filter(Boolean)))
        : [];

      await contactRef.set({
        ownerId,
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
      });

      await captureRef.set(
        {
          status: "ready",
          resultContactId: contactId,
          rawExtraction: parsedJson,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Processing failed";
      logger.error("processCaptureOnCreate failed", { captureId, message });
      await captureRef.set(
        {
          status: "error",
          error: message,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
  },
);

export const cleanupOldCaptureImages = onSchedule(
  { schedule: "every day 03:15", region: "us-central1" },
  async () => {
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(now - thirtyDaysMs);

    const snapshot = await db
      .collection("captures")
      .where("createdAt", "<", cutoff)
      .where("imagesDeletedAt", "==", null)
      .limit(200)
      .get();

    if (snapshot.empty) return;

    const bucket = storage.bucket();

    await Promise.all(
      snapshot.docs.map(async (docSnap) => {
        const captureId = docSnap.id;
        const data = docSnap.data() as CaptureDoc;
        const imagePaths = (data.imagePaths ?? []).slice(0, 100);

        await Promise.all(
          imagePaths.map(async (path) => {
            try {
              await bucket.file(path).delete({ ignoreNotFound: true });
            } catch {
              // ignore
            }
          }),
        );

        await docSnap.ref.set(
          {
            imagePaths: [],
            imagesDeletedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        logger.info("Deleted old capture images", { captureId, count: imagePaths.length });
      }),
    );
  },
);


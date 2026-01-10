"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanupOldCaptureImages = exports.processCaptureOnCreate = void 0;
const app_1 = require("firebase-admin/app");
const firestore_1 = require("firebase-admin/firestore");
const storage_1 = require("firebase-admin/storage");
const firestore_2 = require("firebase-functions/v2/firestore");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firebase_functions_1 = require("firebase-functions");
const dotenv_1 = require("dotenv");
const path_1 = require("path");
const extractionSchema_1 = require("./extractionSchema");
const openrouter_1 = require("./openrouter");
// Load .env.local from root directory for local development
// This runs when the function code loads (both in emulator and deployed)
// For emulator: process.cwd() is functions/, so go up one level
// For deployed: secrets are used, but this won't hurt
try {
    const rootEnvPath = (0, path_1.resolve)(__dirname, "../../.env.local");
    (0, dotenv_1.config)({ path: rootEnvPath });
}
catch {
    // Ignore if .env.local doesn't exist (deployed functions use secrets)
}
(0, app_1.initializeApp)();
const db = (0, firestore_1.getFirestore)();
const storage = (0, storage_1.getStorage)();
const toDataUrl = (mimeType, bytes) => {
    const base64 = bytes.toString("base64");
    return `data:${mimeType};base64,${base64}`;
};
const guessMimeTypeFromPath = (path) => {
    const lower = path.toLowerCase();
    if (lower.endsWith(".png"))
        return "image/png";
    if (lower.endsWith(".webp"))
        return "image/webp";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg"))
        return "image/jpeg";
    return "application/octet-stream";
};
exports.processCaptureOnCreate = (0, firestore_2.onDocumentCreated)({
    document: "captures/{captureId}",
    region: "us-central1",
    // Only use secrets in production; local dev uses .env.local
    secrets: process.env.NODE_ENV === "production" ? ["OPENROUTER_API_KEY"] : undefined,
}, async (event) => {
    const captureId = event.params.captureId;
    const snap = event.data;
    if (!snap)
        return;
    const capture = snap.data();
    const ownerId = capture.ownerId;
    const captureRef = db.collection("captures").doc(captureId);
    if (!ownerId) {
        await captureRef.set({
            status: "error",
            error: "Missing ownerId",
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
        return;
    }
    // Mark as processing
    await captureRef.set({
        status: "processing",
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
    try {
        const imagePaths = (capture.imagePaths ?? []).slice(0, 6);
        const bucket = storage.bucket();
        const imageParts = await Promise.all(imagePaths.map(async (path, idx) => {
            const file = bucket.file(path);
            const [bytes] = await file.download();
            const mime = guessMimeTypeFromPath(path);
            return {
                type: "image_url",
                image_url: { url: toDataUrl(mime, bytes) },
                _idx: idx,
            };
        }));
        const systemPrompt = (0, extractionSchema_1.buildExtractionSystemPrompt)();
        const userText = [
            "Extract a lead/contact from the pasted text and the images.",
            "If you infer something from images, state evidence like 'screenshot #N'.",
            "Pasted text:",
            (capture.text ?? "").trim() || "(none)",
        ].join("\n\n");
        const { model } = (0, openrouter_1.getOpenRouterConfig)();
        const content = await (0, openrouter_1.openRouterChat)({
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
        let parsedJson;
        try {
            parsedJson = (0, extractionSchema_1.safeParseModelJson)(content);
        }
        catch (err) {
            // One repair retry
            const repair = await (0, openrouter_1.openRouterChat)({
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
            parsedJson = (0, extractionSchema_1.safeParseModelJson)(repair);
        }
        const extraction = extractionSchema_1.contactExtractionSchema.parse(parsedJson);
        const contactRef = db.collection("contacts").doc();
        const contactId = contactRef.id;
        const contact = extraction.contact ?? {};
        const tags = Array.isArray(contact.tags)
            ? Array.from(new Set(contact.tags.map((t) => `${t}`.trim()).filter(Boolean)))
            : [];
        await contactRef.set({
            ownerId,
            createdAt: firestore_1.FieldValue.serverTimestamp(),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
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
        await captureRef.set({
            status: "ready",
            resultContactId: contactId,
            rawExtraction: parsedJson,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "Processing failed";
        firebase_functions_1.logger.error("processCaptureOnCreate failed", { captureId, message });
        await captureRef.set({
            status: "error",
            error: message,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
    }
});
exports.cleanupOldCaptureImages = (0, scheduler_1.onSchedule)({ schedule: "every day 03:15", region: "us-central1" }, async () => {
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(now - thirtyDaysMs);
    const snapshot = await db
        .collection("captures")
        .where("createdAt", "<", cutoff)
        .where("imagesDeletedAt", "==", null)
        .limit(200)
        .get();
    if (snapshot.empty)
        return;
    const bucket = storage.bucket();
    await Promise.all(snapshot.docs.map(async (docSnap) => {
        const captureId = docSnap.id;
        const data = docSnap.data();
        const imagePaths = (data.imagePaths ?? []).slice(0, 100);
        await Promise.all(imagePaths.map(async (path) => {
            try {
                await bucket.file(path).delete({ ignoreNotFound: true });
            }
            catch {
                // ignore
            }
        }));
        await docSnap.ref.set({
            imagePaths: [],
            imagesDeletedAt: firestore_1.FieldValue.serverTimestamp(),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
        firebase_functions_1.logger.info("Deleted old capture images", { captureId, count: imagePaths.length });
    }));
});

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeParseModelJson = exports.buildExtractionSystemPrompt = exports.contactExtractionSchema = void 0;
const zod_1 = require("zod");
exports.contactExtractionSchema = zod_1.z.object({
    contact: zod_1.z
        .object({
        fullName: zod_1.z.string().optional().nullable(),
        firstName: zod_1.z.string().optional().nullable(),
        lastName: zod_1.z.string().optional().nullable(),
        jobTitle: zod_1.z.string().optional().nullable(),
        companyName: zod_1.z.string().optional().nullable(),
        email: zod_1.z.string().optional().nullable(),
        phone: zod_1.z.string().optional().nullable(),
        linkedInUrl: zod_1.z.string().optional().nullable(),
        website: zod_1.z.string().optional().nullable(),
        location: zod_1.z.string().optional().nullable(),
        notes: zod_1.z.string().optional().nullable(),
        tags: zod_1.z.array(zod_1.z.string()).optional().nullable()
    })
        .default({}),
    confidenceByField: zod_1.z.record(zod_1.z.string(), zod_1.z.number()).optional().default({}),
    evidence: zod_1.z.record(zod_1.z.string(), zod_1.z.string()).optional().default({})
});
const buildExtractionSystemPrompt = () => {
    return [
        "You extract structured lead/contact fields from the provided text and images.",
        "Return ONLY valid JSON (no markdown, no code fences).",
        "If a field is unknown, set it to null or omit it.",
        "Prefer short evidence strings (e.g. 'Seen in screenshot #2 header').",
        "Emails/phones should be normalized if possible.",
        "Output must match this TypeScript shape:",
        JSON.stringify({
            contact: {
                fullName: "string|null",
                firstName: "string|null",
                lastName: "string|null",
                jobTitle: "string|null",
                companyName: "string|null",
                email: "string|null",
                phone: "string|null",
                linkedInUrl: "string|null",
                website: "string|null",
                location: "string|null",
                notes: "string|null",
                tags: ["string"]
            },
            confidenceByField: { email: 0.82, companyName: 0.9 },
            evidence: { companyName: "Seen in screenshot #2 headline" }
        }, null, 2)
    ].join("\n");
};
exports.buildExtractionSystemPrompt = buildExtractionSystemPrompt;
const safeParseModelJson = (value) => {
    const trimmed = value.trim();
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        throw new Error("Model did not return JSON");
    }
    const jsonSlice = trimmed.slice(firstBrace, lastBrace + 1);
    return JSON.parse(jsonSlice);
};
exports.safeParseModelJson = safeParseModelJson;

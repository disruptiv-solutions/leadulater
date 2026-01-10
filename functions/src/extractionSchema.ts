import { z } from "zod";

export const contactExtractionSchema = z.object({
  contact: z
    .object({
      fullName: z.string().optional().nullable(),
      firstName: z.string().optional().nullable(),
      lastName: z.string().optional().nullable(),
      jobTitle: z.string().optional().nullable(),
      companyName: z.string().optional().nullable(),
      email: z.string().optional().nullable(),
      phone: z.string().optional().nullable(),
      linkedInUrl: z.string().optional().nullable(),
      website: z.string().optional().nullable(),
      location: z.string().optional().nullable(),
      notes: z.string().optional().nullable(),
      tags: z.array(z.string()).optional().nullable()
    })
    .default({}),
  confidenceByField: z.record(z.string(), z.number()).optional().default({}),
  evidence: z.record(z.string(), z.string()).optional().default({})
});

export type ContactExtraction = z.infer<typeof contactExtractionSchema>;

export const buildExtractionSystemPrompt = () => {
  return [
    "You extract structured lead/contact fields from the provided text and images.",
    "Return ONLY valid JSON (no markdown, no code fences).",
    "If a field is unknown, set it to null or omit it.",
    "Prefer short evidence strings (e.g. 'Seen in screenshot #2 header').",
    "Emails/phones should be normalized if possible.",
    "Output must match this TypeScript shape:",
    JSON.stringify(
      {
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
      },
      null,
      2,
    )
  ].join("\n");
};

export const safeParseModelJson = (value: string): unknown => {
  const trimmed = value.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Model did not return JSON");
  }
  const jsonSlice = trimmed.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonSlice);
};


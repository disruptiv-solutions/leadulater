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
      tags: z.array(z.string()).optional().nullable(),
      socialFollowers: z
        .array(
          z.object({
            platform: z.enum([
              "x",
              "twitter",
              "instagram",
              "linkedin",
              "youtube",
              "tiktok",
              "facebook",
              "threads",
              "github",
              "reddit",
              "pinterest",
              "twitch",
              "other",
            ]),
            // Be tolerant: some models omit count on a given entry; we'll drop invalid entries server-side.
            count: z.number().optional().nullable(),
            label: z.string().optional().nullable(),
            url: z.string().optional().nullable(),
            handle: z.string().optional().nullable(),
            // Be tolerant: models may output "subs", "subscriber", etc. We'll normalize server-side when merging.
            metric: z.string().optional().nullable(),
          }),
        )
        .optional()
        .nullable(),
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
    "",
    "Follower counts:",
    "- If you see follower/subscriber counts for social platforms (e.g. '12.3K followers on Instagram'), extract them into contact.socialFollowers.",
    "- Use numeric counts (e.g. 12300), not '12.3K'.",
    "- Use platform enum values: x, twitter, instagram, linkedin, youtube, tiktok, facebook, threads, github, reddit, pinterest, twitch, other.",
    "- Include url or handle when available. metric should be 'followers' (default) or 'subscribers' (YouTube).",
    "",
    "IMPORTANT: Name parsing:",
    "- If you find a full name (e.g., 'John Smith' or 'Smith, John'), parse it into firstName and lastName.",
    "- Set fullName to the complete name as found, and populate firstName and lastName separately.",
    "- For names like 'John Smith', firstName='John', lastName='Smith'.",
    "- For names like 'Smith, John' or 'John Michael Smith', parse appropriately.",
    "- If only one name part is found, use it for firstName and leave lastName null (or vice versa if it's clearly a last name).",
    "",
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
          tags: ["string"],
          socialFollowers: [
            {
              platform: "instagram",
              count: 12345,
              handle: "@handle",
              url: "https://instagram.com/handle",
              metric: "followers",
            },
          ],
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

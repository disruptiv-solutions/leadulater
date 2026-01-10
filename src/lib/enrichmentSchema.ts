import { z } from "zod";

/**
 * Enrichment schema: used AFTER deep research to cleanly update the contact.
 * - contactPatch: fields to overwrite on the ContactDoc (null means clear).
 * - researchFields: dynamic key/value fields to display in UI (e.g. "Twitter", "GitHub", "Education").
 * - summary: a concise human-readable research summary.
 */
export const contactEnrichmentSchema = z.object({
  contactPatch: z
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
    })
    .default({}),

  summary: z.string().optional().nullable(),

  // Dynamic / extra fields from research (links, handles, education, etc.)
  // Keep values as short strings (or null to omit).
  researchFields: z.record(z.string(), z.string().nullable()).optional().default({}),

  // Structured follower/subscriber counts (for dynamic UI rendering)
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
    .default([]),

  // Extra links not covered by standard fields (socials, profiles, press, etc.)
  extraLinks: z
    .array(
      z.object({
        label: z.string().min(1),
        url: z.string().min(1),
      }),
    )
    .optional()
    .default([]),
});

export type ContactEnrichment = z.infer<typeof contactEnrichmentSchema>;

export const buildEnrichmentSystemPrompt = () => {
  return [
    "You are given: (1) an initial extracted contact, and (2) deep research text with citations.",
    "Your job: produce a clean JSON object that updates the contact fields and extracts useful extra fields.",
    "",
    "Rules:",
    "- Return ONLY valid JSON (no markdown, no code fences).",
    "- Prefer reliable info corroborated by citations.",
    "- If a field is unknown, set it to null or omit it.",
    "- Parse names: if you see a full name, populate firstName and lastName too when possible.",
    "- summary MUST be a concise, human-readable summary suitable for the contact's Notes field.",
    "- Put the most important disambiguation and key facts into summary (e.g. 'not the founder of X; likely confused with Y').",
    "",
    "- researchFields should be a flat object of short key/value strings. Use keys like:",
    "  Twitter, X, GitHub, Instagram, YouTube, TikTok, Facebook, Crunchbase, AngelList, PersonalWebsite, Blog, Publications, Education, PreviousCompanies, KeyProjects, Keywords",
    "- If a field is a URL, store the URL string.",
    "",
    "- socialFollowers: if the research provides follower/subscriber counts, extract them here as structured entries.",
    "  Use numeric counts (e.g. 12300) and platform enum values: x, twitter, instagram, linkedin, youtube, tiktok, facebook, threads, github, reddit, pinterest, twitch, other.",
    "  Set metric to 'subscribers' for YouTube when appropriate; otherwise 'followers'. Include url/handle when available.",
    "",
    "- extraLinks: include URLs you found that are relevant (social profiles, personal site, Crunchbase, articles).",
    "  Use short labels. Do NOT include citation bracket numbers in URLs.",
    "",
    "Output shape:",
    JSON.stringify(
      {
        contactPatch: {
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
        },
        summary: "string|null",
        researchFields: {
          Twitter: "https://twitter.com/handle",
          GitHub: "https://github.com/user",
          Education: "School — Degree — Year",
        },
        socialFollowers: [
          { platform: "instagram", count: 12345, url: "https://instagram.com/handle", metric: "followers" },
          { platform: "youtube", count: 56000, url: "https://youtube.com/@handle", metric: "subscribers" },
        ],
        extraLinks: [{ label: "Crunchbase", url: "https://www.crunchbase.com/..." }],
      },
      null,
      2,
    ),
  ].join("\n");
};


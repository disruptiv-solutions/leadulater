import { getOpenRouterConfig, openRouterChat } from "@/lib/openrouter";
import { safeParseModelJson } from "@/lib/extractionSchema";
import { normalizeUrl } from "@/app/api/_utils/researchImages";

export type ExtraLink = { label: string; url: string };

type Candidate = { url: string; title?: string | null; source?: string };

const extractUrlsFromText = (text: string): string[] => {
  if (!text) return [];
  const out: string[] = [];

  // Markdown links: [label](url)
  const md = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
  for (const m of text.matchAll(md)) {
    if (m[1]) out.push(m[1]);
  }

  // Bare urls
  const bare = /(https?:\/\/[^\s)<>\]]+)/g;
  for (const m of text.matchAll(bare)) {
    if (m[1]) out.push(m[1]);
  }

  return out;
};

const uniqByUrl = (items: Candidate[]): Candidate[] => {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const it of items) {
    const url = normalizeUrl(it.url);
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ ...it, url });
  }
  return out;
};

const toExtraLinks = (links: unknown): ExtraLink[] => {
  if (!Array.isArray(links)) return [];
  return links
    .map((l: any) => ({
      label: `${l?.label ?? ""}`.trim(),
      url: normalizeUrl(l?.url),
    }))
    .filter((l) => l.label.length > 0 && l.url.length > 0);
};

export async function curateExtraLinks(args: {
  contact: {
    fullName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    companyName?: string | null;
    email?: string | null;
    linkedInUrl?: string | null;
    website?: string | null;
  };
  researchText: string;
  sources: Array<{ title?: string | null; url?: string | null; date?: string | null }>;
  enrichmentExtraLinks: ExtraLink[];
  existingExtraLinks: ExtraLink[];
  maxLinks?: number;
}): Promise<ExtraLink[]> {
  const maxLinks = Math.max(3, Math.min(args.maxLinks ?? 12, 20));

  const candidates: Candidate[] = [];

  for (const s of args.sources ?? []) {
    if (s?.url) candidates.push({ url: s.url, title: s?.title ?? null, source: "perplexity" });
  }
  for (const u of extractUrlsFromText(args.researchText ?? "")) {
    candidates.push({ url: u, title: null, source: "researchText" });
  }
  for (const l of args.enrichmentExtraLinks ?? []) {
    candidates.push({ url: l.url, title: l.label, source: "enrichment" });
  }
  for (const l of args.existingExtraLinks ?? []) {
    candidates.push({ url: l.url, title: l.label, source: "existing" });
  }

  const uniq = uniqByUrl(candidates).slice(0, 80);
  if (uniq.length === 0) return [];

  const contactName =
    (args.contact.fullName ?? "").trim() ||
    [args.contact.firstName, args.contact.lastName].filter(Boolean).join(" ").trim();

  const promptUser = [
    "You are curating a CRM contact's 'Additional links'.",
    "Goal: choose the most relevant, correct links for this specific person/company and dedupe them.",
    "",
    "Contact context:",
    JSON.stringify(
      {
        name: contactName || null,
        companyName: args.contact.companyName ?? null,
        email: args.contact.email ?? null,
        website: args.contact.website ?? null,
        linkedInUrl: args.contact.linkedInUrl ?? null,
      },
      null,
      2,
    ),
    "",
    "Candidate links (url + optional title + source):",
    JSON.stringify(uniq, null, 2),
    "",
    "Rules:",
    `- Return ONLY JSON in the exact schema.`,
    `- Pick up to ${maxLinks} links.`,
    "- Prefer official + high-signal links: official website, LinkedIn, Crunchbase, company/about pages, reputable press, profiles.",
    "- Avoid duplicates, tracking params, and irrelevant pages.",
    "- Use short, human labels (e.g. 'LinkedIn', 'Website', 'Crunchbase', 'Press').",
  ].join("\n");

  const { apiKey, model } = getOpenRouterConfig();

  // Use structured outputs via direct fetch (openRouterChat helper doesn't expose response_format).
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "http://localhost",
      "X-Title": "crm-companion",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content:
            "You return structured JSON only. You curate links. Do not include markdown. Do not include commentary.",
        },
        { role: "user", content: promptUser },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "curated_links",
          strict: true,
          schema: {
            type: "object",
            properties: {
              links: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    url: { type: "string" },
                  },
                  required: ["label", "url"],
                  additionalProperties: false,
                },
              },
            },
            required: ["links"],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  let content: string | null = null;
  try {
    const json = (await res.json()) as any;
    content = json?.choices?.[0]?.message?.content ?? null;
  } catch {
    // ignore
  }

  // Parse with our robust slicer + one repair retry if needed.
  let parsed: any;
  try {
    if (!content) throw new Error("Empty content");
    parsed = safeParseModelJson(content);
  } catch (err) {
    const repair = await openRouterChat({
      model,
      temperature: 0,
      max_tokens: 1200,
      messages: [
        { role: "system", content: "Return ONLY valid JSON. No markdown." },
        {
          role: "user",
          content: [
            "Fix this into valid JSON matching the schema:",
            JSON.stringify({ links: [{ label: "Website", url: "https://example.com" }] }, null, 2),
            "",
            "Invalid output:",
            `${content ?? ""}`,
          ].join("\n\n"),
        },
      ],
    });
    parsed = safeParseModelJson(repair);
  }

  const links = toExtraLinks(parsed?.links).slice(0, maxLinks);
  return links;
}


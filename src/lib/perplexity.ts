import Perplexity from "@perplexity-ai/perplexity_ai";

export type PerplexitySearchResult = {
  title?: string;
  url?: string;
  date?: string;
};

export type PerplexityImageResult = {
  image_url?: string;
  url?: string;
  title?: string;
};

export type DeepResearchResult = {
  content: string;
  search_results: PerplexitySearchResult[];
  images: PerplexityImageResult[];
};

const getPerplexityApiKey = (): string => {
  const v = process.env.PERPLEXITY_API_KEY?.trim();
  if (v) return v;
  throw new Error("Missing required env var: PERPLEXITY_API_KEY");
};

const getPerplexityImageConfig = () => {
  // Enable returning images by default (Sonar feature).
  // You can override via env vars if desired.
  const returnImagesEnv = process.env.PERPLEXITY_RETURN_IMAGES?.trim().toLowerCase();
  const returnImages =
    returnImagesEnv === "false" ? false : true; // default true

  const domainFilterEnv = process.env.PERPLEXITY_IMAGE_DOMAIN_FILTER?.trim() || "";
  const formatFilterEnv = process.env.PERPLEXITY_IMAGE_FORMAT_FILTER?.trim() || "";

  const image_domain_filter =
    domainFilterEnv.length > 0
      ? domainFilterEnv.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10)
      : [
          // sane defaults to avoid watermarked / low-signal sources
          "-gettyimages.com",
          "-shutterstock.com",
          "-istockphoto.com",
          "-pinterest.com",
        ];

  const image_format_filter =
    formatFilterEnv.length > 0
      ? formatFilterEnv.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 10)
      : ["jpg", "png", "webp"];

  return { return_images: returnImages, image_domain_filter, image_format_filter };
};

export const buildDeepResearchPrompt = (contactInfo: {
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  email?: string | null;
  linkedInUrl?: string | null;
  website?: string | null;
  jobTitle?: string | null;
  location?: string | null;
}): string => {
  // Build research prompt from available contact information
  const researchParts: string[] = [];
  
  if (contactInfo.fullName) {
    researchParts.push(`Name: ${contactInfo.fullName}`);
  } else if (contactInfo.firstName || contactInfo.lastName) {
    researchParts.push(`Name: ${[contactInfo.firstName, contactInfo.lastName].filter(Boolean).join(" ")}`);
  }
  
  if (contactInfo.companyName) {
    researchParts.push(`Company: ${contactInfo.companyName}`);
  }
  
  if (contactInfo.jobTitle) {
    researchParts.push(`Job Title: ${contactInfo.jobTitle}`);
  }
  
  if (contactInfo.email) {
    researchParts.push(`Email: ${contactInfo.email}`);
  }
  
  if (contactInfo.linkedInUrl) {
    researchParts.push(`LinkedIn: ${contactInfo.linkedInUrl}`);
  }
  
  if (contactInfo.website) {
    researchParts.push(`Website: ${contactInfo.website}`);
  }
  
  if (contactInfo.location) {
    researchParts.push(`Location: ${contactInfo.location}`);
  }

  const researchPrompt = [
    "Conduct deep research on the following person. Find comprehensive information including:",
    "- Professional background and career history",
    "- Current role and responsibilities",
    "- Company information and industry",
    "- Social media profiles (LinkedIn, Twitter, etc.)",
    "- Recent news, publications, or mentions",
    "- Professional achievements and notable work",
    "- Educational background if available",
    "- Any other relevant professional or public information",
    "",
    "Person to research:",
    researchParts.join("\n"),
    "",
    "Provide a comprehensive research report with sources and citations.",
  ].join("\n");

  return researchPrompt;
};

export const performDeepResearch = async (contactInfo: {
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  email?: string | null;
  linkedInUrl?: string | null;
  website?: string | null;
  jobTitle?: string | null;
  location?: string | null;
}): Promise<DeepResearchResult> => {
  const client = new Perplexity({ apiKey: getPerplexityApiKey() });
  const prompt = buildDeepResearchPrompt(contactInfo);
  const imageCfg = getPerplexityImageConfig();

  const completion = await client.chat.completions.create({
    model: "sonar-deep-research",
    ...imageCfg,
    messages: [{ role: "user", content: prompt }],
  } as any);

  const content = completion?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Perplexity Deep Research returned empty content");

  return {
    content,
    search_results: (completion as any).search_results ?? [],
    images: (completion as any).images ?? [],
  };
};

export const streamDeepResearchConcise = async (contactInfo: {
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  email?: string | null;
  linkedInUrl?: string | null;
  website?: string | null;
  jobTitle?: string | null;
  location?: string | null;
}) => {
  const client = new Perplexity({ apiKey: getPerplexityApiKey() });
  const prompt = buildDeepResearchPrompt(contactInfo);
  const imageCfg = getPerplexityImageConfig();

  const stream = await client.chat.completions.create({
    model: "sonar-deep-research",
    ...imageCfg,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    stream_mode: "concise",
  } as any);

  return stream as AsyncIterable<any>;
};

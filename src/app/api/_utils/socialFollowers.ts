export type SocialPlatform =
  | "x"
  | "twitter"
  | "instagram"
  | "linkedin"
  | "youtube"
  | "tiktok"
  | "facebook"
  | "threads"
  | "github"
  | "reddit"
  | "pinterest"
  | "twitch"
  | "other";

export type SocialFollowerMetric = "followers" | "subscribers";

export type SocialFollower = {
  platform: SocialPlatform;
  count: number;
  label?: string | null;
  url?: string | null;
  handle?: string | null;
  metric?: SocialFollowerMetric | null;
};

const asString = (v: unknown): string => (typeof v === "string" ? v : `${v ?? ""}`).trim();

const normalizePlatform = (raw: unknown): SocialPlatform => {
  const v = asString(raw).toLowerCase();
  if (!v) return "other";
  if (v === "x") return "x";
  if (v === "twitter") return "twitter";
  if (v === "instagram") return "instagram";
  if (v === "linkedin") return "linkedin";
  if (v === "youtube") return "youtube";
  if (v === "tiktok") return "tiktok";
  if (v === "facebook") return "facebook";
  if (v === "threads") return "threads";
  if (v === "github") return "github";
  if (v === "reddit") return "reddit";
  if (v === "pinterest") return "pinterest";
  if (v === "twitch") return "twitch";
  return "other";
};

const canonicalPlatform = (p: SocialPlatform): SocialPlatform => {
  // Store "twitter" as "x" to avoid duplicate entries from mixed naming.
  return p === "twitter" ? "x" : p;
};

const normalizeMetric = (raw: unknown): SocialFollowerMetric | null => {
  const v = asString(raw).toLowerCase();
  if (!v) return null;
  if (v.includes("sub")) return "subscribers";
  return "followers";
};

const normalizeFollower = (raw: unknown): SocialFollower | null => {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as any;

  const platform = canonicalPlatform(normalizePlatform(obj.platform));
  const count = typeof obj.count === "number" ? obj.count : Number(asString(obj.count));
  if (!Number.isFinite(count) || count < 0) return null;

  const url = asString(obj.url) || null;
  const handle = asString(obj.handle) || null;
  const label = asString(obj.label) || null;
  const metric = normalizeMetric(obj.metric);

  return {
    platform,
    count: Math.round(count),
    ...(label ? { label } : {}),
    ...(url ? { url } : {}),
    ...(handle ? { handle } : {}),
    ...(metric ? { metric } : {}),
  };
};

const chooseBetter = (a: SocialFollower, b: SocialFollower): SocialFollower => {
  // Prefer higher count; if tie, prefer one with a URL/handle.
  if (b.count > a.count) return b;
  if (a.count > b.count) return a;
  const aHas = Boolean(a.url) || Boolean(a.handle);
  const bHas = Boolean(b.url) || Boolean(b.handle);
  if (bHas && !aHas) return b;
  if (aHas && !bHas) return a;
  return b.label && !a.label ? { ...a, label: b.label } : a;
};

export const mergeSocialFollowers = (existing: unknown, incoming: unknown): SocialFollower[] | undefined => {
  const ex = Array.isArray(existing) ? existing.map(normalizeFollower).filter(Boolean) : [];
  const inc = Array.isArray(incoming) ? incoming.map(normalizeFollower).filter(Boolean) : [];
  if (ex.length === 0 && inc.length === 0) return undefined;

  const byPlatform = new Map<SocialPlatform, SocialFollower>();
  for (const item of [...ex, ...inc]) {
    const current = byPlatform.get(item.platform);
    byPlatform.set(item.platform, current ? chooseBetter(current, item) : item);
  }

  return Array.from(byPlatform.values()).sort((a, b) => b.count - a.count);
};


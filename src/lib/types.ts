export type CaptureStatus = "queued" | "processing" | "researching" | "ready" | "error";

export type CrmDoc = {
  ownerId: string;
  name: string;
  memberIds: string[];
  createdAt: unknown;
  updatedAt: unknown;
};

export type UserPrefsDoc = {
  defaultCrmId?: string | null;
  activeCrmId?: string | null;
  activeScope?: "crm" | "overview" | null;
  createdAt?: unknown;
  updatedAt?: unknown;
};

export type CaptureDoc = {
  ownerId: string;
  crmId?: string;
  memberIds?: string[];
  status: CaptureStatus;
  text: string;
  imagePaths: string[];
  createdAt: unknown;
  updatedAt: unknown;
  error?: string;
  resultContactId?: string;
  rawExtraction?: unknown;
  imagesDeletedAt?: unknown;
  deepResearchEnabled?: boolean;
};

export type ContactAiMetadata = {
  confidenceByField?: Record<string, number>;
  evidence?: Record<string, string>;
};

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

export type PurchaseCadence = "monthly" | "yearly" | "one_off";
export type PurchaseStage = "possible" | "converted";

export type ContactPurchase = {
  id: string;
  stage: PurchaseStage;
  cadence: PurchaseCadence;
  name: string;
  amount?: number | null;
  currency?: string | null;
  notes?: string | null;
  // Optional subscription span. If endDateMs is missing, it is treated as active through "today" in calculations.
  startDateMs?: number | null;
  endDateMs?: number | null;
  // Stored as client timestamps because Firestore serverTimestamp() isn't supported inside array elements.
  createdAtMs?: number | null;
  updatedAtMs?: number | null;
};

export type ProductDoc = {
  ownerId: string;
  crmId?: string;
  memberIds?: string[];
  createdAt: unknown;
  updatedAt: unknown;
  name: string;
  cadence: PurchaseCadence;
  amount?: number | null;
  currency?: string | null;
};

export type ContactDoc = {
  ownerId: string;
  crmId?: string;
  memberIds?: string[];
  createdAt: unknown;
  updatedAt: unknown;
  isDraft: boolean;
  sourceCaptureId?: string;

  fullName?: string;
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
  companyName?: string;
  email?: string;
  phone?: string;
  linkedInUrl?: string;
  website?: string;
  location?: string;
  leadStatus?: "not_sure" | "cold" | "warm" | "hot" | "customer";
  profileImagePath?: string;
  notes?: string;
  tags: string[];
  socialFollowers?: SocialFollower[];
  purchases?: ContactPurchase[];

  ai?: ContactAiMetadata;
  deepResearchStatus?: "disabled" | "queued" | "running" | "done" | "error";
  deepResearchPrompt?: string;
  deepResearchRaw?: string;
  deepResearchSummary?: string;
  deepResearchError?: string;
  researchFields?: Record<string, string | null>;
  deepResearchSources?: Array<{ title?: string | null; url?: string | null; date?: string | null }>;
  researchImages?: Array<{
    storagePath: string;
    sourceUrl?: string | null;
    title?: string | null;
  }>;
  extraLinks?: Array<{ label: string; url: string }>;
};

export type NoteDoc = {
  contactId: string;
  ownerId: string;
  crmId?: string;
  memberIds?: string[];
  content: string;
  createdAt: unknown;
  updatedAt: unknown;
};


export type FirebasePublicEnv = {
  NEXT_PUBLIC_FIREBASE_API_KEY: string;
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: string;
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: string;
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: string;
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: string;
  NEXT_PUBLIC_FIREBASE_APP_ID: string;
};

const getRequiredPublicEnv = (name: keyof FirebasePublicEnv, value: string | undefined): string => {
  if (typeof value === "string" && value.trim().length > 0) return value;
  // Allow Next.js to build/prerender without local env wired up.
  // In the browser (real runtime), we want a hard failure so misconfig is obvious.
  if (typeof window === "undefined") return "";
  throw new Error(`Missing required env var: ${name}`);
};

export const getFirebasePublicEnv = (): FirebasePublicEnv => {
  return {
    // NOTE: these must be accessed statically so Next can inline NEXT_PUBLIC_* values.
    NEXT_PUBLIC_FIREBASE_API_KEY: getRequiredPublicEnv(
      "NEXT_PUBLIC_FIREBASE_API_KEY",
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    ),
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: getRequiredPublicEnv(
      "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    ),
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: getRequiredPublicEnv(
      "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    ),
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: getRequiredPublicEnv(
      "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    ),
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: getRequiredPublicEnv(
      "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    ),
    NEXT_PUBLIC_FIREBASE_APP_ID: getRequiredPublicEnv(
      "NEXT_PUBLIC_FIREBASE_APP_ID",
      process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    ),
  };
};


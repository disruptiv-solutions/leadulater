import { getStorage } from "firebase/storage";
import { getFirebaseApp } from "@/lib/firebase/client";
import { getFirebasePublicEnv } from "@/lib/env";

const getBucketUrl = (): string | undefined => {
  try {
    const env = getFirebasePublicEnv();
    const bucket = env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET?.trim();
    if (!bucket) return undefined;
    return bucket.startsWith("gs://") ? bucket : `gs://${bucket}`;
  } catch {
    return undefined;
  }
};

// Force the bucket from env to avoid accidental fallback to *.appspot.com.
export const storage = getStorage(getFirebaseApp(), getBucketUrl());


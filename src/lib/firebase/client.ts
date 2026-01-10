import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getFirebasePublicEnv } from "@/lib/env";

export const getFirebaseApp = (): FirebaseApp => {
  const existing = getApps()[0];
  if (existing) return existing;

  const env = getFirebasePublicEnv();
  return initializeApp({
    apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.NEXT_PUBLIC_FIREBASE_APP_ID,
  });
};


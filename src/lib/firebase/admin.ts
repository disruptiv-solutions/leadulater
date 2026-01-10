import { initializeApp, getApps, cert, type App } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import { getFirestore } from "firebase-admin/firestore";

let adminApp: App | null = null;

export const getAdminApp = (): App => {
  if (adminApp) return adminApp;

  const existing = getApps()[0];
  if (existing) {
    adminApp = existing;
    return adminApp;
  }

  // Initialize with service account from environment
  // In production, Firebase Functions automatically provides credentials
  // For local dev, use GOOGLE_APPLICATION_CREDENTIALS or SERVICE_ACCOUNT_JSON
  const serviceAccountJson = process.env.SERVICE_ACCOUNT_JSON;
  
  if (serviceAccountJson) {
    try {
      const serviceAccount = JSON.parse(serviceAccountJson);
      adminApp = initializeApp({
        credential: cert(serviceAccount),
        storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET,
      });
    } catch (err) {
      throw new Error(`Failed to parse SERVICE_ACCOUNT_JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    // Use default credentials (works in Firebase Functions or with GOOGLE_APPLICATION_CREDENTIALS)
    adminApp = initializeApp({
      storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET,
    });
  }

  return adminApp;
};

export const getAdminStorage = () => {
  return getStorage(getAdminApp());
};

export const getAdminFirestore = () => {
  return getFirestore(getAdminApp());
};

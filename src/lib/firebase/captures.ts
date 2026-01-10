import { getIdToken } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase/auth";

export type CreateCaptureInput = {
  ownerId: string;
  crmId: string;
  text: string;
  images: File[];
  enableDeepResearch?: boolean;
  maxImages?: number;
  maxBytesPerImage?: number;
  uploadTimeoutMs?: number;
  createDocTimeoutMs?: number;
};

export type CreateCaptureOutput = {
  captureId: string;
  imagePaths: string[];
};

export const createCaptureWithUploads = async (
  input: CreateCaptureInput,
): Promise<CreateCaptureOutput> => {
  // Get auth token for API route
  const auth = getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) {
    throw new Error("Not authenticated");
  }

  const idToken = await getIdToken(user);

  // Build form data
  const formData = new FormData();
  formData.append("ownerId", input.ownerId);
  formData.append("crmId", input.crmId);
  formData.append("text", input.text);
  formData.append("enableDeepResearch", (input.enableDeepResearch ?? false).toString());
  input.images.forEach((file, idx) => {
    formData.append(`image${idx + 1}`, file);
  });

  // POST to API route
  const response = await fetch("/api/captures/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Upload failed" }));
    throw new Error(error.error || `Upload failed: ${response.statusText}`);
  }

  const result = await response.json();
  return {
    captureId: result.captureId,
    imagePaths: result.imagePaths,
  };
};


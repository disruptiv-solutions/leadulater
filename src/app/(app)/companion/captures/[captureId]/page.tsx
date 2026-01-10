"use client";

export const dynamic = "force-dynamic";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  documentId,
  limit,
  onSnapshot,
  query,
  updateDoc,
  where,
} from "firebase/firestore";
import { deleteObject, getDownloadURL, ref } from "firebase/storage";
import { db, nowServerTimestamp } from "@/lib/firebase/firestore";
import { storage } from "@/lib/firebase/storage";
import { useAuth } from "@/lib/hooks/useAuth";
import type { CaptureDoc } from "@/lib/types";

type ImagePreview = {
  path: string;
  url: string | null;
};

export default function CaptureProgressPage() {
  const router = useRouter();
  const params = useParams<{ captureId: string }>();
  const captureId = params.captureId;

  const { user } = useAuth();
  const ownerId = user?.uid ?? null;

  const [capture, setCapture] = useState<CaptureDoc | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [imagePreviews, setImagePreviews] = useState<ImagePreview[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);

  const captureDocRef = useMemo(() => doc(db, "captures", captureId), [captureId]);
  const captureMemberQuery = useMemo(() => {
    if (!ownerId) return null;
    return query(
      collection(db, "captures"),
      where("memberIds", "array-contains", ownerId),
      where(documentId(), "==", captureId),
      limit(1),
    );
  }, [captureId, ownerId]);

  useEffect(() => {
    if (!captureMemberQuery) return;

    const unsubscribe = onSnapshot(
      captureMemberQuery,
      (snapshot) => {
        setIsLoading(false);
        if (snapshot.empty) {
          setCapture(null);
          return;
        }
        setCapture(snapshot.docs[0]!.data() as CaptureDoc);
      },
      (err) => {
        console.error("Capture snapshot error:", (err as any)?.code, (err as any)?.message, err);
        setIsLoading(false);
        setCapture(null);
      },
    );

    return () => {
      unsubscribe();
    };
  }, [captureMemberQuery]);

  useEffect(() => {
    if (!capture) return;

    if (capture.status === "ready" && capture.resultContactId) {
      router.replace(`/contacts/${capture.resultContactId}`);
    }
  }, [capture, router]);

  useEffect(() => {
    if (!capture?.imagePaths?.length) {
      setImagePreviews([]);
      return;
    }

    let cancelled = false;
    const run = async () => {
      const previews = await Promise.all(
        capture.imagePaths.slice(0, 6).map(async (path) => {
          try {
            const url = await getDownloadURL(ref(storage, path));
            return { path, url } satisfies ImagePreview;
          } catch {
            return { path, url: null } satisfies ImagePreview;
          }
        }),
      );
      if (!cancelled) setImagePreviews(previews);
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [capture?.imagePaths]);

  const handleRetry = async () => {
    if (!capture || capture.status !== "error") return;
    if (!ownerId) return;
    const canEdit = capture.ownerId === ownerId || capture.memberIds?.includes(ownerId);
    if (!canEdit) return;

    await updateDoc(captureDocRef, {
      status: "queued",
      error: deleteField(),
      updatedAt: nowServerTimestamp(),
    });
  };

  const handleDelete = async () => {
    if (!capture || !ownerId) return;
    const canDelete = capture.ownerId === ownerId || capture.memberIds?.includes(ownerId);
    if (!canDelete) return;
    if (!confirm("Are you sure you want to delete this capture? This cannot be undone.")) return;

    setIsDeleting(true);
    try {
      // Delete images from Storage
      if (capture.imagePaths?.length) {
        await Promise.allSettled(
          capture.imagePaths.map((path) => deleteObject(ref(storage, path))),
        );
      }

      // Delete capture document
      await deleteDoc(captureDocRef);

      // Redirect to dashboard
      router.push("/dashboard");
    } catch (err) {
      console.error("Delete error:", err);
      alert("Failed to delete capture. Please try again.");
      setIsDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <div className="text-sm text-zinc-600">Loading capture…</div>
      </div>
    );
  }

  if (!capture) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h1 className="text-lg font-semibold tracking-tight">Capture not found</h1>
        <p className="mt-1 text-sm text-zinc-600">
          This capture may not exist, or you may not have access.
        </p>
      </div>
    );
  }

  if (ownerId && capture.ownerId !== ownerId) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h1 className="text-lg font-semibold tracking-tight">Not authorized</h1>
        <p className="mt-1 text-sm text-zinc-600">
          You don’t have access to this capture.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Capture</h1>
        <p className="mt-1 text-sm text-zinc-600">
          We’ll automatically redirect when the contact is ready.
        </p>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-4">
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div className="space-y-1">
            <div className="text-sm font-medium text-zinc-900">Status</div>
            <div className="text-sm text-zinc-600">
              <span className="font-medium text-zinc-900">{capture.status}</span>
              {capture.status === "processing" || capture.status === "queued" ? " · Extracting…" : ""}
              {capture.status === "researching" ? " · Deep researching…" : ""}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {capture.status === "error" ? (
              <button
                type="button"
                onClick={handleRetry}
                className="rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-800"
                aria-label="Retry processing this capture"
              >
                Retry
              </button>
            ) : null}
            <button
              type="button"
              onClick={handleDelete}
              disabled={isDeleting}
              className="rounded-xl border border-red-200 bg-white px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              aria-label="Delete this capture"
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>

        {capture.status === "error" && capture.error ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {capture.error}
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-zinc-200 bg-white p-4">
          <div className="text-sm font-medium text-zinc-900">Images</div>
          {imagePreviews.length ? (
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {imagePreviews.map((img) => (
                <div
                  key={img.path}
                  className="relative overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50"
                >
                  <div className="relative aspect-square">
                    {img.url ? (
                      <Image
                        src={img.url}
                        alt="Capture image"
                        fill
                        className="object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-xs text-zinc-500">
                        Preview unavailable
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-3 rounded-xl bg-zinc-50 px-4 py-6 text-sm text-zinc-600">
              No images attached.
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-white p-4">
          <div className="text-sm font-medium text-zinc-900">Text</div>
          <div className="mt-3 whitespace-pre-wrap rounded-xl bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
            {capture.text?.trim() ? capture.text.trim() : "No text provided."}
          </div>
        </div>
      </div>
    </div>
  );
}


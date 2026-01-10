"use client";

export const dynamic = "force-dynamic";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/hooks/useAuth";
import { useCrm } from "@/lib/hooks/useCrm";
import { createCaptureWithUploads } from "@/lib/firebase/captures";

type LocalImage = {
  id: string;
  file: File;
  previewUrl: string;
};

const toLocalImage = (file: File): LocalImage => ({
  id: crypto.randomUUID(),
  file,
  previewUrl: URL.createObjectURL(file),
});

const isImageFile = (file: File) => file.type.startsWith("image/");

export default function CompanionPage() {
  const router = useRouter();
  const { user } = useAuth();
  const ownerId = user?.uid ?? null;
  const { activeScope, activeCrmId, crms, isLoading: isCrmLoading } = useCrm();

  const [overviewCrmId, setOverviewCrmId] = useState<string>("");

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imagesRef = useRef<LocalImage[]>([]);
  const [images, setImages] = useState<LocalImage[]>([]);
  const [text, setText] = useState<string>("");
  const [enableDeepResearch, setEnableDeepResearch] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submitStage, setSubmitStage] = useState<string | null>(null);

  const crmIdForSubmission = useMemo(() => {
    if (activeScope === "overview") {
      return overviewCrmId.trim() || null;
    }
    return activeCrmId?.trim() || null;
  }, [activeCrmId, activeScope, overviewCrmId]);

  const canSubmit = useMemo(() => {
    return Boolean(
      !isSubmitting &&
        !!crmIdForSubmission &&
        (images.length > 0 || text.trim().length > 0),
    );
  }, [crmIdForSubmission, images.length, isSubmitting, text]);

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(() => {
    return () => {
      imagesRef.current.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    };
  }, []);

  const handlePickFiles = () => {
    fileInputRef.current?.click();
  };

  const handleAddFiles = (files: File[]) => {
    setError(null);

    const nextImages = files.filter(isImageFile).map(toLocalImage);
    if (nextImages.length === 0) {
      setError("No image files found.");
      return;
    }

    const merged = [...images, ...nextImages].slice(0, 6);
    if (merged.length !== images.length + nextImages.length) {
      nextImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      setError("Max 6 images allowed.");
    }

    setImages(merged);
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    handleAddFiles(files);
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const files = items
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter((f): f is File => Boolean(f));

    if (files.length === 0) return;
    handleAddFiles(files);
  };

  const handleRemoveImage = (id: string) => {
    setImages((prev) => {
      const target = prev.find((x) => x.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
  };

  const handleClearAll = () => {
    images.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    setImages([]);
    setText("");
    setError(null);
  };

  const handleSubmit = async () => {
    if (!ownerId) return;
    if (!crmIdForSubmission) {
      setError(activeScope === "overview" ? "Pick a CRM before submitting." : "Loading CRM…");
      return;
    }

    setError(null);
    setIsSubmitting(true);
    setSubmitStage("Uploading images…");
    try {
      const { captureId } = await createCaptureWithUploads({
        ownerId,
        crmId: crmIdForSubmission,
        text: text.trim(),
        images: images.map((x) => x.file),
        enableDeepResearch,
        maxImages: 6,
        maxBytesPerImage: 10 * 1024 * 1024,
        uploadTimeoutMs: 30_000,
        createDocTimeoutMs: 20_000,
      });

      handleClearAll();
      setSubmitStage("Creating capture…");
      router.push(`/companion/captures/${captureId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Capture failed";
      setError(message);
    } finally {
      setIsSubmitting(false);
      setSubmitStage(null);
    }
  };

  return (
    <div className="space-y-6">

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Quick Capture</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Paste or upload up to 6 images, optionally add text, then submit.
        </p>
      </div>

      {activeScope === "overview" ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <div className="text-sm font-medium text-amber-900">Choose a business</div>
          <div className="mt-1 text-xs text-amber-800">
            You’re in Overview. Pick which CRM this capture should be saved into.
          </div>
          <div className="mt-3">
            <label className="text-xs font-medium text-zinc-700" htmlFor="overviewCrm">
              Save into
            </label>
            <select
              id="overviewCrm"
              value={overviewCrmId}
              onChange={(e) => setOverviewCrmId(e.target.value)}
              className="mt-1 w-full rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm outline-none focus:border-amber-300"
              aria-label="Select CRM for this capture"
              disabled={isCrmLoading}
            >
              <option value="">Select a CRM…</option>
              {crms.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.data.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      <div
        className="rounded-2xl border border-dashed border-zinc-300 bg-white p-4"
        onPaste={handlePaste}
        tabIndex={0}
        aria-label="Paste images here"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") handlePickFiles();
        }}
      >
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div className="space-y-1">
            <div className="text-sm font-medium text-zinc-900">
              Add images (max 6)
            </div>
            <div className="text-xs text-zinc-600">
              Tip: click here and paste from clipboard (Ctrl+V), or use the file picker.
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePickFiles}
              className="rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-800"
              aria-label="Upload images"
            >
              Upload images
            </button>
            <button
              type="button"
              onClick={handleClearAll}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-900 hover:bg-zinc-100"
              aria-label="Clear all images and text"
            >
              Clear
            </button>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="hidden"
          onChange={handleFileChange}
          aria-label="Pick image files"
        />

        {images.length ? (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {images.map((img) => (
              <div
                key={img.id}
                className="relative overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50"
              >
                <div className="relative aspect-square">
                  <Image
                    src={img.previewUrl}
                    alt="Selected capture image"
                    fill
                    className="object-cover"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => handleRemoveImage(img.id)}
                  className="absolute right-2 top-2 rounded-lg bg-white/90 px-2 py-1 text-xs text-zinc-900 shadow-sm hover:bg-white"
                  aria-label="Remove image"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-4 rounded-xl bg-zinc-50 px-4 py-6 text-sm text-zinc-600">
            No images yet. Paste (Ctrl+V) or click “Upload images”.
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-4">
        <label className="text-sm font-medium text-zinc-900" htmlFor="captureText">
          Optional text
        </label>
        <textarea
          id="captureText"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="mt-2 min-h-28 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none ring-0 placeholder:text-zinc-400 focus:border-zinc-400"
          placeholder="Paste any notes, context, LinkedIn snippet, or anything you want the model to use."
        />
      </div>

      {error ? (
        <div
          className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <div className="rounded-2xl border border-zinc-200 bg-white p-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={enableDeepResearch}
            onChange={(e) => setEnableDeepResearch(e.target.checked)}
            className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-500"
            aria-label="Enable deep research"
          />
          <div>
            <div className="text-sm font-medium text-zinc-900">Enable Deep Research</div>
            <div className="text-xs text-zinc-600">
              Automatically research this person using Perplexity Deep Research after extraction
            </div>
          </div>
        </label>
      </div>

      <div className="flex items-center justify-end">
        <div className="flex flex-col items-end gap-2">
          {submitStage ? (
            <div className="text-xs text-zinc-600" aria-label="Submit status">
              {submitStage}
            </div>
          ) : null}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || !ownerId}
            className="rounded-xl bg-zinc-900 px-5 py-3 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Submit quick capture"
          >
            {isSubmitting ? "Submitting…" : "Submit"}
          </button>
        </div>
      </div>
    </div>
  );
}


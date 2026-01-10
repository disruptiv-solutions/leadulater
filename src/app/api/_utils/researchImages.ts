import { getAdminStorage } from "@/lib/firebase/admin";

type InputImage = {
  url?: string;
  image_url?: string;
  title?: string;
};

const guessExtFromContentType = (ct: string | null): string => {
  const v = (ct || "").toLowerCase();
  if (v.includes("png")) return "png";
  if (v.includes("webp")) return "webp";
  if (v.includes("jpeg") || v.includes("jpg")) return "jpg";
  return "jpg";
};

export async function persistResearchImages(params: {
  ownerId: string;
  contactId: string;
  images: InputImage[];
  maxImages?: number;
}): Promise<Array<{ storagePath: string; sourceUrl: string; title?: string | null }>> {
  const maxImages = params.maxImages ?? 6;
  const bucket = getAdminStorage().bucket();

  const out: Array<{ storagePath: string; sourceUrl: string; title?: string | null }> = [];
  const toSave = (params.images ?? []).slice(0, maxImages);

  for (let i = 0; i < toSave.length; i++) {
    const img = toSave[i]!;
    const src = img.image_url || img.url;
    if (!src) continue;

    // Best-effort download
    const res = await fetch(src);
    if (!res.ok) continue;
    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    if (buf.length === 0) continue;

    const ct = res.headers.get("content-type");
    const ext = guessExtFromContentType(ct);
    const storagePath = `users/${params.ownerId}/contacts/${params.contactId}/research/img_${i + 1}.${ext}`;

    await bucket.file(storagePath).save(buf, {
      metadata: {
        contentType: ct || undefined,
      },
    });

    out.push({ storagePath, sourceUrl: src, title: img.title ?? null });
  }

  return out;
}

export function normalizeUrl(input: string): string | null {
  const raw = `${input}`.trim();
  if (!raw) return null;
  // Accept http/https only
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  // If it looks like a domain, prefix https
  if (/^[\w.-]+\.[a-z]{2,}([/].*)?$/i.test(raw)) return `https://${raw}`;
  return null;
}



import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { getOpenRouterConfig } from "@/lib/openrouter";
import Papa from "papaparse";

/**
 * CSV Upload API for Contacts
 *
 * IMPORTANT: We do NOT ask the model to output the entire contact list (too brittle).
 * Instead we:
 * - Parse the CSV locally (reliable)
 * - Ask the model (via OpenRouter) to map CSV column headers -> our base fields (small, structured)
 * - Build contact docs deterministically from the parsed rows (no deep research here)
 * 
 * Example CSV formats supported:
 * - First Name, Last Name, Email, Phone, Company
 * - Name, Email Address, Phone Number, Organization
 * - Full Name, Contact Email, Mobile, Business Name
 * 
 * The AI will automatically detect and map columns to the appropriate fields.
 */

type ContactInput = {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  jobTitle?: string;
  linkedInUrl?: string;
  website?: string;
  location?: string;
  notes?: string;
  tags?: string[];
};

type FieldKey = keyof ContactInput;

const normalizeHeader = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\uFEFF\u200B]/g, "") // BOM / zero-width
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const buildHeuristicHeaderMap = (): Map<string, FieldKey> => {
  const m = new Map<string, FieldKey>();

  // name
  ["first name", "firstname", "given name", "givenname"].forEach((k) => m.set(k, "firstName"));
  ["last name", "lastname", "surname", "family name", "familyname"].forEach((k) => m.set(k, "lastName"));
  ["name", "full name", "fullname", "contact name", "contactname"].forEach((k) => m.set(k, "fullName"));

  // contact
  ["email", "email address", "emailaddress", "e mail", "e mail address"].forEach((k) => m.set(k, "email"));
  ["phone", "phone number", "phonenumber", "mobile", "mobile phone", "cell", "cell phone"].forEach((k) => m.set(k, "phone"));

  // company
  ["company", "company name", "companyname", "organization", "org", "business", "business name"].forEach((k) =>
    m.set(k, "companyName"),
  );
  ["title", "job title", "jobtitle", "position", "role"].forEach((k) => m.set(k, "jobTitle"));
  ["linkedin", "linkedin url", "linkedin profile", "linkedinprofile", "linkedinurl"].forEach((k) => m.set(k, "linkedInUrl"));
  ["website", "url", "web site", "homepage"].forEach((k) => m.set(k, "website"));

  // location (single field in our schema)
  ["location", "city", "state", "province", "region", "country"].forEach((k) => m.set(k, "location"));

  // misc
  ["notes", "note", "comments", "comment", "tags"].forEach((k) => m.set(k, "notes"));
  ["tag", "tags", "labels", "label"].forEach((k) => m.set(k, "tags"));

  return m;
};

const parseTags = (value: unknown): string[] => {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return [];
  const parts = raw
    .split(/[;,|]/g)
    .flatMap((p) => p.split(",")) // support mixed delimiters
    .map((t) => t.trim())
    .filter(Boolean);
  return Array.from(new Set(parts));
};

const safeParseJsonObject = (value: string): any => {
  const trimmed = `${value ?? ""}`.trim();
  // First try strict parse.
  try {
    return JSON.parse(trimmed);
  } catch {
    // Then try to slice the first {...} block out of any surrounding text.
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) throw new Error("No JSON object found");
    const slice = trimmed.slice(first, last + 1);
    return JSON.parse(slice);
  }
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { csvContent, ownerId, crmId } = body;

    if (!csvContent || !ownerId || !crmId) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Limit CSV size to prevent issues (500KB max)
    if (csvContent.length > 500000) {
      return NextResponse.json(
        { error: "CSV file is too large. Please upload files smaller than 500KB or split into multiple files." },
        { status: 400 }
      );
    }

    // 1) Parse CSV locally (reliable)
    const parsedCsv = Papa.parse<Record<string, unknown>>(csvContent, {
      header: true,
      skipEmptyLines: "greedy",
      dynamicTyping: false,
      delimiter: "", // auto-detect
      transform: (v) => (typeof v === "string" ? v.trim() : v),
    });

    if (parsedCsv.errors?.length) {
      return NextResponse.json(
        { error: `CSV parse error: ${parsedCsv.errors[0]?.message || "Unknown error"}` },
        { status: 400 },
      );
    }

    const rows = (parsedCsv.data || []).filter((r) => r && Object.keys(r).length > 0);
    const headers = (parsedCsv.meta.fields || []).filter(Boolean);

    if (headers.length === 0 || rows.length === 0) {
      return NextResponse.json(
        { error: "No rows found in CSV. Ensure the first row contains headers." },
        { status: 400 },
      );
    }

    // Guardrails: Firestore batch limit is 500 writes. Keep room for safety.
    if (rows.length > 450) {
      return NextResponse.json(
        { error: `CSV has ${rows.length} rows. Please upload 450 contacts or fewer per file (or split the file).` },
        { status: 400 },
      );
    }

    // 2) Ask AI for a header->field mapping (small structured output)
    const { apiKey, model } = getOpenRouterConfig();

    const sampleRows = rows.slice(0, Math.min(5, rows.length));
    const mappingResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "http://localhost",
        "X-Title": "crm-companion",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 1200,
        messages: [
          {
            role: "system",
            content:
              "You map CSV headers to CRM contact base fields. Do not invent data. Prefer null when unsure.",
          },
          {
            role: "user",
            content: [
              "Given these CSV headers and sample rows, map each header to ONE of the allowed fields, or null if it doesn't fit.",
              "Return each header EXACTLY as provided (do not rename headers).",
              "",
              "Allowed fields:",
              "firstName, lastName, fullName, email, phone, companyName, jobTitle, linkedInUrl, website, location, notes, tags",
              "",
              "Notes on tags:",
              "- If there is a Tags/Labels column, map it to 'tags'.",
              "- The tags cell may be comma/semicolon/pipe separated. We'll split/dedupe later.",
              "",
              "CSV headers:",
              JSON.stringify(headers),
              "",
              "Sample rows:",
              JSON.stringify(sampleRows),
            ].join("\n"),
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "csv_header_mapping",
            strict: true,
            schema: {
              type: "object",
              properties: {
                mapping: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      header: { type: "string" },
                      field: {
                        anyOf: [
                          { type: "string", enum: [
                            "firstName",
                            "lastName",
                            "fullName",
                            "email",
                            "phone",
                            "companyName",
                            "jobTitle",
                            "linkedInUrl",
                            "website",
                            "location",
                            "notes",
                            "tags",
                          ] },
                          { type: "null" },
                        ],
                      },
                    },
                    required: ["header", "field"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["mapping"],
              additionalProperties: false,
            },
          },
        },
      }),
    });

    if (!mappingResponse.ok) {
      const error = await mappingResponse.json().catch(() => ({}));
      throw new Error(error.error?.message || `OpenRouter error (${mappingResponse.status})`);
    }

    const mappingJson = await mappingResponse.json();
    const mappingContent = mappingJson.choices?.[0]?.message?.content;
    if (!mappingContent) throw new Error("OpenRouter returned empty mapping content");

    // mappingContent should be valid JSON due to json_schema, but some provider/model routes can still violate it.
    // If it does, we fall back to heuristics (so upload still succeeds for standard CSVs).
    let mappingParsed: any = { mapping: [] };
    let usedAiMapping = true;
    try {
      mappingParsed = safeParseJsonObject(mappingContent);
    } catch (err) {
      usedAiMapping = false;
    }

    const mappingArray: Array<{ header: string; field: FieldKey | null }> = mappingParsed.mapping || [];
    const headerToField = new Map<string, FieldKey>();
    const heuristic = buildHeuristicHeaderMap();

    // Build a normalized mapping so minor header formatting differences won't drop fields.
    const headerNormToField = new Map<string, FieldKey>();
    for (const m of mappingArray) {
      if (m?.header && m?.field) {
        headerToField.set(m.header, m.field);
        headerNormToField.set(normalizeHeader(m.header), m.field);
      }
    }

    // 3) Build contact objects deterministically from rows
    const contacts: ContactInput[] = [];
    for (const row of rows) {
      const c: ContactInput = {};
      let rawTags: unknown = null;
      for (const header of headers) {
        const headerNorm = normalizeHeader(header);
        const field = headerToField.get(header) || headerNormToField.get(headerNorm) || heuristic.get(headerNorm);
        if (!field) continue;
        const raw = (row as any)?.[header];
        const value = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw).trim();
        if (!value) continue;

        if (field === "tags") {
          // Collect tags raw and parse after the loop (dedupe across multiple tag columns)
          rawTags = rawTags ? `${rawTags}, ${value}` : value;
          continue;
        }

        // last-write-wins if duplicates map to same field
        (c as any)[field] = value;
      }

      // If fullName is missing but first/last exist, generate it
      if (!c.fullName) {
        const parts = [c.firstName, c.lastName].filter(Boolean);
        if (parts.length) c.fullName = parts.join(" ");
      }

      const tags = parseTags(rawTags);
      if (tags.length) c.tags = tags;

      // Skip empty contacts
      if (Object.keys(c).length === 0) continue;
      contacts.push(c);
    }

    if (contacts.length === 0) {
      return NextResponse.json(
        { error: "No contacts could be created from this CSV (mapping produced no usable fields)." },
        { status: 400 },
      );
    }

    // Create contacts in Firestore
    const adminDb = getAdminFirestore();
    const timestamp = FieldValue.serverTimestamp();
    const memberIds = [ownerId];

    // Chunk into batches (max 500 writes per batch; we already cap to 450 rows)
    const chunkSize = 400;
    for (let i = 0; i < contacts.length; i += chunkSize) {
      const batch = adminDb.batch();
      const chunk = contacts.slice(i, i + chunkSize);
      for (const contact of chunk) {
        const contactRef = adminDb.collection("contacts").doc();
        batch.set(contactRef, {
          ...contact,
          tags: Array.isArray((contact as any).tags) ? (contact as any).tags : [],
          ownerId,
          crmId,
          memberIds,
          isDraft: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      await batch.commit();
    }

    return NextResponse.json({
      success: true,
      count: contacts.length,
      rowsParsed: rows.length,
      headersFound: headers.length,
      mappedHeaders: Array.from(
        new Set(
          headers
            .map((h) => headerToField.get(h) || headerNormToField.get(normalizeHeader(h)) || heuristic.get(normalizeHeader(h)))
            .filter(Boolean),
        ),
      ).length,
      usedAiMapping,
      message: `Successfully uploaded ${contacts.length} contact(s)`,
    });

  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 }
    );
  }
}

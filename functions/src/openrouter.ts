export type OpenRouterChatMessage =
  | { role: "system"; content: string }
  | {
      role: "user";
      content:
        | string
        | Array<
            | { type: "text"; text: string }
            | { type: "image_url"; image_url: { url: string } }
          >;
    }
  | { role: "assistant"; content: string };

export type OpenRouterChatRequest = {
  model: string;
  messages: OpenRouterChatMessage[];
  temperature?: number;
  max_tokens?: number;
};

type OpenRouterChatResponse = {
  choices?: Array<{
    message?: { role?: string; content?: string | null };
  }>;
  error?: { message?: string };
};

const getRequiredEnv = (key: string): string => {
  const value = process.env[key];
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new Error(`Missing required env var: ${key}`);
};

export const getOpenRouterConfig = () => {
  // For Firebase Functions v2, secrets are available via process.env
  // For local dev, use .env file
  // For deployed functions, use Firebase Secrets
  return {
    apiKey: getRequiredEnv("OPENROUTER_API_KEY"),
    model: process.env.OPENROUTER_MODEL?.trim() || "google/gemini-3-flash-preview",
  };
};

export const openRouterChat = async (req: OpenRouterChatRequest): Promise<string> => {
  const { apiKey } = getOpenRouterConfig();

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // Optional OpenRouter headers (safe defaults)
      "HTTP-Referer": "http://localhost",
      "X-Title": "crm-companion",
    },
    body: JSON.stringify(req),
  });

  const json = (await response.json()) as OpenRouterChatResponse;

  if (!response.ok) {
    const message = json?.error?.message || `OpenRouter error (${response.status})`;
    throw new Error(message);
  }

  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned empty content");
  return content;
};


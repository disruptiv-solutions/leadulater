"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openRouterChat = exports.getOpenRouterConfig = void 0;
const getRequiredEnv = (key) => {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0)
        return value;
    throw new Error(`Missing required env var: ${key}`);
};
const getOpenRouterConfig = () => {
    // For Firebase Functions v2, secrets are available via process.env
    // For local dev, use .env file
    // For deployed functions, use Firebase Secrets
    return {
        apiKey: getRequiredEnv("OPENROUTER_API_KEY"),
        model: process.env.OPENROUTER_MODEL?.trim() || "google/gemini-3-flash-preview",
    };
};
exports.getOpenRouterConfig = getOpenRouterConfig;
const openRouterChat = async (req) => {
    const { apiKey } = (0, exports.getOpenRouterConfig)();
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
    const json = (await response.json());
    if (!response.ok) {
        const message = json?.error?.message || `OpenRouter error (${response.status})`;
        throw new Error(message);
    }
    const content = json.choices?.[0]?.message?.content;
    if (!content)
        throw new Error("OpenRouter returned empty content");
    return content;
};
exports.openRouterChat = openRouterChat;

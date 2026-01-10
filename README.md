# leadulater

## CRM Companion (MVP)

Next.js + Firebase app for **Quick Capture → AI extraction → editable Contact → Contacts list**.

## Setup

### 1) Create Firebase project

Enable:
- Firebase Auth: **Google**
- Firestore
- Storage

### 2) Configure client env vars

Copy `env.example` to `.env.local` and fill values from Firebase Web App config.

### 3) Configure Functions env vars

Copy `functions/env.example` to `functions/.env` (or set env vars in your deployment environment):
- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL` (default: `google/gemini-3-flash-preview`)

### 4) Set your Firebase project id

Edit `.firebaserc` and replace `YOUR_FIREBASE_PROJECT_ID`.

## Run locally

```bash
npm run dev
```

## What’s implemented

- `/login` Google sign-in
- `/dashboard` quick stats + recent captures
- `/companion` upload/paste up to 6 images + optional text
- `/companion/captures/[captureId]` progress watcher + auto-redirect to contact
- `/contacts` contacts table
- `/contacts/[contactId]` editable contact + “Save Contact”
- Firestore trigger: `captures/{id}` → OpenRouter extraction → create draft contact → update capture ready
- Scheduled cleanup: delete capture images after 30 days

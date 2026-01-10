export const dynamic = "force-dynamic";

export default function OfflinePage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col items-center justify-center px-4 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">You’re offline</h1>
      <p className="mt-2 text-sm text-zinc-600">
        CRM Companion needs an internet connection for Firebase and AI processing.
        You can reload when you’re back online.
      </p>
    </div>
  );
}


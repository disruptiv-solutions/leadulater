import { Suspense } from "react";
import { LoginClient } from "./LoginClient";

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center bg-zinc-50 px-4 text-zinc-900">
          <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm">
            Loading…
          </div>
        </div>
      }
    >
      <LoginClient />
    </Suspense>
  );
}


"use client";

import { useEffect } from "react";

export const PwaRegister = () => {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    const isLocalhost =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";
    const isProd = process.env.NODE_ENV === "production";

    // In dev, don't register a SW (it can cache old bundles/env and cause confusing behavior).
    // Also proactively unregister any previously-registered SW on localhost.
    if (!isProd || isLocalhost) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .catch(() => {});

      if ("caches" in window) {
        caches
          .keys()
          .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
          .catch(() => {});
      }
      return;
    }

    const handleRegister = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js");

        // If a new SW is waiting, activate it on reload.
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            // When installed and there's an existing controller, a refresh will pick up updates.
            if (installing.state !== "installed") return;
          });
        });
      } catch {
        // Ignore registration errors (e.g., unsupported dev setups)
      }
    };

    void handleRegister();
  }, []);

  return null;
};


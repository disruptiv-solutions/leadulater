"use client";

import { useEffect, useMemo, useState } from "react";
import type { User } from "firebase/auth";
import { onAuthStateChanged } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase/auth";

export type AuthState = {
  user: User | null;
  isLoading: boolean;
};

export const useAuth = (): AuthState => {
  const auth = useMemo(() => {
    if (typeof window === "undefined") return null;
    return getFirebaseAuth();
  }, []);
  const [user, setUser] = useState<User | null>(auth?.currentUser ?? null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    if (!auth) return;
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setIsLoading(false);
    });

    return unsubscribe;
  }, [auth]);

  useEffect(() => {
    if (!auth) setIsLoading(false);
  }, [auth]);

  return { user, isLoading };
};


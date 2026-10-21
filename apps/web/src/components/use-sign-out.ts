"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";

/** Signs out through Better Auth and returns to the login page. */
export function useSignOut(): () => Promise<void> {
  const router = useRouter();
  return useCallback(async () => {
    const { error } = await authClient.signOut();
    if (error) {
      toast.error("Sign-out failed", { description: error.message });
      return;
    }
    router.replace("/login");
    router.refresh();
  }, [router]);
}

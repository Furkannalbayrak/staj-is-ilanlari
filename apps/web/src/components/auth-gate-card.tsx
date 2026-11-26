"use client";

import { LogIn } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { hasSupabaseEnv } from "@/lib/utils";

interface AuthGateCardProps {
  title: string;
  description: string;
}

export function AuthGateCard({ title, description }: AuthGateCardProps) {
  async function handleLogin() {
    if (!hasSupabaseEnv()) {
      alert("Önce apps/web/.env.local dosyasına Supabase bilgilerini ekleyin.");
      return;
    }
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
  }

  return (
    <div className="mx-auto max-w-md rounded-xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-950">
      <h1 className="text-base font-semibold text-zinc-950 dark:text-zinc-50">{title}</h1>
      <p className="mt-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        {description}
      </p>
      <button
        type="button"
        onClick={handleLogin}
        className="mt-5 inline-flex h-9 items-center gap-2 rounded-md bg-blue-700 px-4 text-xs font-medium text-white transition-colors hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500"
      >
        <LogIn className="h-3.5 w-3.5" />
        Google ile Giriş Yap
      </button>
    </div>
  );
}

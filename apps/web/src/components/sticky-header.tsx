"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { Bell, Bookmark, Briefcase, LogIn, LogOut, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { cn, hasSupabaseEnv } from "@/lib/utils";

interface StickyHeaderProps {
  initialUser: User | null;
}

export function StickyHeader({ initialUser }: StickyHeaderProps) {
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [user, setUser] = useState<User | null>(initialUser);
  const [authLoading, setAuthLoading] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (!hasSupabaseEnv()) return;

    const supabase = createClient();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  async function handleGoogleLogin() {
    if (!hasSupabaseEnv()) {
      alert("Önce apps/web/.env.local dosyasına Supabase bilgilerini eklemelisiniz.");
      return;
    }
    setAuthLoading(true);
    try {
      const supabase = createClient();
      await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleSignOut() {
    if (!hasSupabaseEnv()) return;
    const supabase = createClient();
    await supabase.auth.signOut();
    setUser(null);
    window.location.href = "/";
  }

  const navItems = [
    { href: "/", label: "İlanlar", icon: Briefcase },
    { href: "/saved", label: "Kaydedilenler", icon: Bookmark },
    { href: "/alerts", label: "Alarmlar", icon: Bell },
  ];

  return (
    <header className="sticky top-0 z-40 h-14 border-b border-slate-200/90 bg-white/95 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/95">
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="flex items-center gap-2.5 text-sm font-bold tracking-tight text-slate-900 dark:text-slate-50"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-700 text-xs font-bold text-white shadow-xs dark:bg-blue-600">
              K
            </span>
            <span>KariyerRadar TR</span>
          </Link>

          <nav className="hidden items-center gap-1 sm:flex">
            {navItems.map(({ href, label, icon: Icon }) => {
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "bg-blue-50 text-blue-700 font-semibold dark:bg-blue-950/70 dark:text-blue-300"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            aria-label="Tema değiştir"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-slate-50"
          >
            {mounted ? (
              resolvedTheme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )
            ) : (
              <span className="h-4 w-4" />
            )}
          </button>

          {user ? (
            <div className="flex items-center gap-2">
              <span className="hidden max-w-[160px] truncate text-xs text-zinc-600 dark:text-zinc-400 md:inline">
                {user.email}
              </span>
              <button
                type="button"
                onClick={handleSignOut}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 px-2.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                <LogOut className="h-3.5 w-3.5" />
                Çıkış
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={authLoading}
              onClick={handleGoogleLogin}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-blue-700 px-3 text-xs font-medium text-white transition-colors hover:bg-blue-800 disabled:opacity-60 dark:bg-blue-600 dark:hover:bg-blue-500"
            >
              <LogIn className="h-3.5 w-3.5" />
              Google ile Giriş
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

import { createClient } from "@/lib/supabase/server";
import { AuthGateCard } from "@/components/auth-gate-card";
import { AlertsManager } from "@/components/alerts-manager";
import type { AlertRule } from "@/types/database";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const supabase = await createClient();
  const user = supabase ? (await supabase.auth.getUser()).data.user : null;

  if (!supabase || !user) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <AuthGateCard
          title="İlan Alarmları"
          description="Seçtiğin filtrelere uygun yeni iş veya staj ilanı düştüğünde e-posta (Resend) veya Telegram üzerinden bildirim almak için Google hesabınla giriş yap."
        />
      </div>
    );
  }

  const { data } = await supabase
    .from("alerts")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-lg font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
          İlan Alarmları
        </h1>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Worker her çalıştığında yeni düşen ilanlar buradaki kurallarla eşleştirilir ve seçtiğin
          kanala gönderilir.
        </p>
      </div>

      <AlertsManager
        initialAlerts={(data as AlertRule[]) || []}
        userId={user.id}
        userEmail={user.email ?? null}
      />
    </div>
  );
}

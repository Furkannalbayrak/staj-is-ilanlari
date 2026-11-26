"use client";

import { useState } from "react";
import { Bell, Plus, Trash2 } from "lucide-react";
import {
  CATEGORY_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  type AlertRule,
  type EmploymentType,
  type JobCategory,
} from "@/types/database";
import { createClient } from "@/lib/supabase/client";
import { cn, formatRelativeTimeTr } from "@/lib/utils";

interface AlertsManagerProps {
  initialAlerts: AlertRule[];
  userId: string;
  userEmail: string | null;
}

export function AlertsManager({ initialAlerts, userId, userEmail }: AlertsManagerProps) {
  const [alerts, setAlerts] = useState<AlertRule[]>(initialAlerts);
  const [name, setName] = useState("");
  const [keywordsText, setKeywordsText] = useState("");
  const [citiesText, setCitiesText] = useState("");
  const [employmentType, setEmploymentType] = useState<EmploymentType | "">("internship");
  const [category, setCategory] = useState<JobCategory | "">("");
  const [channel, setChannel] = useState<"email" | "telegram" | "both">("email");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const supabase = createClient();
      const keywords = keywordsText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const cities = citiesText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const { data, error } = await supabase
        .from("alerts")
        .insert({
          user_id: userId,
          user_email: userEmail,
          name: name.trim(),
          keywords,
          cities,
          employment_types: employmentType ? [employmentType] : [],
          categories: category ? [category] : [],
          channel,
          telegram_chat_id: telegramChatId.trim() || null,
          is_active: true,
        })
        .select("*")
        .single();

      if (error) {
        alert(`Alarm oluşturulamadı: ${error.message}`);
        return;
      }

      if (data) {
        setAlerts((prev) => [data as AlertRule, ...prev]);
        setName("");
        setKeywordsText("");
        setCitiesText("");
        setTelegramChatId("");
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(alertItem: AlertRule) {
    const supabase = createClient();
    const nextActive = !alertItem.is_active;
    setAlerts((prev) =>
      prev.map((a) => (a.id === alertItem.id ? { ...a, is_active: nextActive } : a))
    );
    await supabase.from("alerts").update({ is_active: nextActive }).eq("id", alertItem.id);
  }

  async function handleDelete(id: string) {
    const supabase = createClient();
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    await supabase.from("alerts").delete().eq("id", id);
  }

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[360px_minmax(0,1fr)]">
      {/* Yeni Alarm Formu */}
      <form
        onSubmit={handleCreate}
        className="h-fit space-y-4 rounded-xl border border-zinc-200 bg-zinc-50/50 p-5 dark:border-zinc-800 dark:bg-zinc-900/30"
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950 dark:text-zinc-50">
          <Plus className="h-4 w-4 text-blue-700 dark:text-blue-400" />
          Yeni İlan Alarmı Kur
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Alarm Adı *
          </label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Örn: İstanbul Yazılım Stajı"
            className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-800 dark:bg-zinc-900"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Anahtar Kelimeler (virgülle)
          </label>
          <input
            value={keywordsText}
            onChange={(e) => setKeywordsText(e.target.value)}
            placeholder="python, backend, staj"
            className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-800 dark:bg-zinc-900"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Şehirler (virgülle)
          </label>
          <input
            value={citiesText}
            onChange={(e) => setCitiesText(e.target.value)}
            placeholder="İstanbul, Ankara"
            className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-800 dark:bg-zinc-900"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
              İlan Türü
            </label>
            <select
              value={employmentType}
              onChange={(e) => setEmploymentType(e.target.value as EmploymentType | "")}
              className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
            >
              <option value="">Fark etmez</option>
              {(Object.entries(EMPLOYMENT_TYPE_LABELS) as [EmploymentType, string][])
                .filter(([k]) => k !== "unknown")
                .map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
              Kategori
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as JobCategory | "")}
              className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
            >
              <option value="">Tümü</option>
              {(Object.entries(CATEGORY_LABELS) as [JobCategory, string][]).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Bildirim Kanalı
          </label>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as "email" | "telegram" | "both")}
            className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-sm dark:border-zinc-800 dark:bg-zinc-900"
          >
            <option value="email">E-posta ({userEmail || "Google hesabı"})</option>
            <option value="telegram">Telegram Bot</option>
            <option value="both">E-posta + Telegram</option>
          </select>
        </div>

        {(channel === "telegram" || channel === "both") && (
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
              Telegram Chat ID
            </label>
            <input
              value={telegramChatId}
              onChange={(e) => setTelegramChatId(e.target.value)}
              placeholder="Örn: 123456789"
              className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-800 dark:bg-zinc-900"
            />
          </div>
        )}

        <button
          type="submit"
          disabled={saving}
          className="inline-flex h-9 w-full items-center justify-center rounded-md bg-blue-700 text-sm font-medium text-white transition-colors hover:bg-blue-800 disabled:opacity-60 dark:bg-blue-600 dark:hover:bg-blue-500"
        >
          {saving ? "Kaydediliyor..." : "Alarm Oluştur"}
        </button>
      </form>

      {/* Mevcut Alarmlar */}
      <div className="space-y-3">
        {alerts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center dark:border-zinc-800">
            <Bell className="mx-auto mb-2 h-6 w-6 text-zinc-400" />
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              Henüz kurulu bir alarmın yok
            </p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Sol taraftan filtrelerini belirleyip yeni ilan düştüğünde anında bildirim alabilirsin.
            </p>
          </div>
        ) : (
          alerts.map((alertItem) => (
            <div
              key={alertItem.id}
              className="flex items-start justify-between gap-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">
                    {alertItem.name}
                  </h3>
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[11px] font-medium",
                      alertItem.is_active
                        ? "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300"
                        : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                    )}
                  >
                    {alertItem.is_active ? "Aktif" : "Duraklatıldı"}
                  </span>
                </div>

                <div className="flex flex-wrap gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                  {alertItem.keywords.map((kw) => (
                    <span
                      key={kw}
                      className="rounded border border-zinc-200 px-1.5 py-0.5 dark:border-zinc-800"
                    >
                      #{kw}
                    </span>
                  ))}
                  {alertItem.cities.map((c) => (
                    <span
                      key={c}
                      className="rounded border border-zinc-200 px-1.5 py-0.5 dark:border-zinc-800"
                    >
                      {c}
                    </span>
                  ))}
                  {alertItem.employment_types.map((t) => (
                    <span
                      key={t}
                      className="rounded border border-zinc-200 px-1.5 py-0.5 dark:border-zinc-800"
                    >
                      {EMPLOYMENT_TYPE_LABELS[t]}
                    </span>
                  ))}
                </div>

                <p className="text-[11px] text-zinc-400">
                  Kanal: {alertItem.channel} · Son bildirim:{" "}
                  {alertItem.last_notified_at
                    ? formatRelativeTimeTr(alertItem.last_notified_at)
                    : "Henüz yok"}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleToggle(alertItem)}
                  className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
                >
                  {alertItem.is_active ? "Duraklat" : "Aktifleştir"}
                </button>
                <button
                  type="button"
                  aria-label="Alarmı sil"
                  onClick={() => handleDelete(alertItem.id)}
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 text-zinc-400 hover:border-red-300 hover:text-red-600 dark:border-zinc-800 dark:hover:border-red-900 dark:hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

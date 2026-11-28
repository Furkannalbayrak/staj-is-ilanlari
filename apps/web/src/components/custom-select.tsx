"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  dotClass?: string;
}

interface CustomSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  icon: React.ReactNode;
  searchable?: boolean;
  searchPlaceholder?: string;
  isActive?: boolean;
  dropUp?: boolean;
}

export function CustomSelect({
  value,
  options,
  onChange,
  icon,
  searchable = false,
  searchPlaceholder = "Ara...",
  isActive = false,
  dropUp = false,
}: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedOption = useMemo(
    () => options.find((o) => o.value === value) ?? options[0],
    [options, value]
  );

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("tr-TR");
    if (!q) return options;
    return options.filter((o) => o.label.toLocaleLowerCase("tr-TR").includes(q));
  }, [options, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    if (searchable) {
      setTimeout(() => inputRef.current?.focus(), 10);
    }

    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, searchable]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-8.5 w-full items-center justify-between gap-2 rounded-lg border px-2.5 text-xs transition-all focus:outline-none",
          open
            ? "border-blue-600 bg-white ring-2 ring-blue-600/15 dark:border-blue-500 dark:bg-slate-900"
            : isActive
              ? "border-blue-300 bg-blue-50/40 font-semibold text-blue-900 hover:border-blue-400 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-200"
              : "border-slate-200 bg-slate-50/80 text-slate-800 hover:border-slate-300 hover:bg-white dark:border-slate-700/80 dark:bg-slate-800/70 dark:text-slate-200 dark:hover:border-slate-600"
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "shrink-0",
              isActive || open ? "text-blue-600 dark:text-blue-400" : "text-slate-400"
            )}
          >
            {icon}
          </span>
          {selectedOption?.dotClass && (
            <span className={cn("h-2 w-2 shrink-0 rounded-full", selectedOption.dotClass)} />
          )}
          <span className="truncate">{selectedOption?.label}</span>
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150",
            open && "rotate-180 text-blue-600 dark:text-blue-400"
          )}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className={cn(
            "absolute left-0 right-0 z-50 overflow-hidden rounded-xl border border-slate-200/90 bg-white shadow-[0_12px_32px_rgba(15,23,42,0.14)] dark:border-slate-700 dark:bg-slate-900 dark:shadow-[0_12px_32px_rgba(0,0,0,0.45)]",
            dropUp ? "bottom-full mb-1.5" : "mt-1.5"
          )}
        >
          {searchable && (
            <div className="border-b border-slate-100 p-1.5 dark:border-slate-800">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={searchPlaceholder}
                  className="h-7.5 w-full rounded-md border border-slate-200 bg-slate-50 pl-7.5 pr-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
              </div>
            </div>
          )}

          <div className="max-h-56 overflow-y-auto p-1">
            {filteredOptions.length === 0 ? (
              <div className="px-2.5 py-3 text-center text-xs text-slate-400">
                Sonuç bulunamadı
              </div>
            ) : (
              filteredOptions.map((opt) => {
                const selected = opt.value === value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
                      selected
                        ? "bg-blue-50 font-semibold text-blue-700 dark:bg-blue-950/70 dark:text-blue-300"
                        : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {opt.dotClass && (
                        <span className={cn("h-2 w-2 shrink-0 rounded-full", opt.dotClass)} />
                      )}
                      <span className="truncate">{opt.label}</span>
                    </span>
                    {selected && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

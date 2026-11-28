"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

interface CompanyAvatarProps {
  name: string;
  logoUrl: string | null | undefined;
  size?: "sm" | "md";
}

export function CompanyAvatar({ name, logoUrl, size = "md" }: CompanyAvatarProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const initial = (name.trim()[0] || "?").toLocaleUpperCase("tr");
  const sizeClass = size === "sm" ? "h-11 w-11 text-sm" : "h-14 w-14 text-base";

  if (logoUrl && !imgFailed) {
    return (
      <div
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200/90 bg-white p-0.5 shadow-xs dark:border-slate-700",
          sizeClass
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logoUrl}
          alt={name}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setImgFailed(true)}
          className="h-full w-full object-contain"
        />
      </div>
    );
  }

  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-100 font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
        sizeClass
      )}
    >
      {initial}
    </div>
  );
}

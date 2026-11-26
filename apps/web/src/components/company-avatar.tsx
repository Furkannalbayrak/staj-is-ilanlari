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
  const sizeClass = size === "sm" ? "h-9 w-9 text-xs" : "h-10 w-10 text-sm";

  if (logoUrl && !imgFailed) {
    return (
      <div
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-zinc-200 bg-white p-1 dark:border-zinc-800",
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
        "flex shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-100 font-semibold text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300",
        sizeClass
      )}
    >
      {initial}
    </div>
  );
}

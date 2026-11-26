import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { StickyHeader } from "@/components/sticky-header";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "KariyerRadar TR — Türkiye İş ve Staj İlanları",
  description:
    "Türkiye'deki güncel kurumsal ve portal iş/staj ilanlarını tek merkezde, hızlı ve temiz bir arayüzle takip edin.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const supabase = await createClient();
  const user = supabase ? (await supabase.auth.getUser()).data.user : null;

  return (
    <html lang="tr" suppressHydrationWarning>
      <body className="min-h-screen font-sans antialiased">
        <ThemeProvider>
          <StickyHeader initialUser={user} />
          <main>{children}</main>
        </ThemeProvider>
      </body>
    </html>
  );
}

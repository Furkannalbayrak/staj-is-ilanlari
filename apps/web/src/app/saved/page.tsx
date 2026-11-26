import { createClient } from "@/lib/supabase/server";
import { AuthGateCard } from "@/components/auth-gate-card";
import { JobBoard } from "@/components/job-board";
import type { Job } from "@/types/database";

export const dynamic = "force-dynamic";

export default async function SavedJobsPage() {
  const supabase = await createClient();
  const user = supabase ? (await supabase.auth.getUser()).data.user : null;

  if (!supabase || !user) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <AuthGateCard
          title="Kaydedilen İlanlar"
          description="Beğendiğin iş ve staj ilanlarını kaydetmek ve tek yerden takip etmek için Google hesabınla giriş yap."
        />
      </div>
    );
  }

  const { data: rows } = await supabase
    .from("saved_jobs")
    .select("job_id, jobs(*)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  const jobs = (rows || [])
    .map((row) => (row as unknown as { jobs: Job | null }).jobs)
    .filter((j): j is Job => Boolean(j));

  return (
    <JobBoard
      initialJobs={jobs}
      initialSavedIds={jobs.map((j) => j.id)}
      lastUpdatedAt={null}
      userId={user.id}
      emptyReason="no_jobs"
    />
  );
}

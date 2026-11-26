import { createClient } from "@/lib/supabase/server";
import { JobBoard } from "@/components/job-board";
import type { Job } from "@/types/database";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const supabase = await createClient();

  if (!supabase) {
    return (
      <JobBoard
        initialJobs={[]}
        initialSavedIds={[]}
        lastUpdatedAt={null}
        userId={null}
        emptyReason="no_env"
      />
    );
  }

  const [{ data: jobsData }, { data: runData }, { data: authData }] = await Promise.all([
    supabase
      .from("jobs")
      .select("*")
      .eq("is_active", true)
      .order("posted_at", { ascending: false, nullsFirst: false })
      .order("first_seen_at", { ascending: false })
      .limit(1000),
    supabase
      .from("scrape_runs")
      .select("finished_at")
      .eq("status", "success")
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.auth.getUser(),
  ]);

  const user = authData.user;
  let savedIds: string[] = [];

  if (user) {
    const { data: savedRows } = await supabase
      .from("saved_jobs")
      .select("job_id")
      .eq("user_id", user.id);
    savedIds = (savedRows || []).map((r) => r.job_id);
  }

  return (
    <JobBoard
      initialJobs={(jobsData as Job[]) || []}
      initialSavedIds={savedIds}
      lastUpdatedAt={runData?.finished_at ?? null}
      userId={user?.id ?? null}
      emptyReason="no_jobs"
    />
  );
}

import { createClient } from "@/lib/supabase/server";
import { JobBoard } from "@/components/job-board";
import { fetchAvailableCities, parseJobFilters, queryJobs } from "@/lib/jobs-query";

export const dynamic = "force-dynamic";

interface HomePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const resolvedParams = await searchParams;
  const initialFilters = parseJobFilters(resolvedParams);
  const supabase = await createClient();

  if (!supabase) {
    return (
      <JobBoard
        serverSide
        initialJobs={[]}
        initialTotalCount={0}
        initialPage={1}
        initialTotalPages={1}
        initialFilters={initialFilters}
        availableCities={[]}
        initialSavedIds={[]}
        lastUpdatedAt={null}
        userId={null}
        emptyReason="no_env"
      />
    );
  }

  const [paginated, availableCities, { data: runData }, { data: authData }] = await Promise.all([
    queryJobs(supabase, initialFilters),
    fetchAvailableCities(supabase, initialFilters.city),
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
      serverSide
      initialJobs={paginated.jobs}
      initialTotalCount={paginated.totalCount}
      initialPage={paginated.page}
      initialTotalPages={paginated.totalPages}
      initialFilters={{ ...initialFilters, page: paginated.page }}
      availableCities={availableCities}
      initialSavedIds={savedIds}
      lastUpdatedAt={runData?.finished_at ?? null}
      userId={user?.id ?? null}
      emptyReason="no_jobs"
    />
  );
}

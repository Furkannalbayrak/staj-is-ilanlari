import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseJobFilters, queryJobs } from "@/lib/jobs-query";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  if (!supabase) {
    return NextResponse.json(
      { jobs: [], totalCount: 0, page: 1, totalPages: 1, pageSize: 50 },
      { status: 200 }
    );
  }

  const filters = parseJobFilters(request.nextUrl.searchParams);
  const result = await queryJobs(supabase, filters);

  return NextResponse.json(result, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

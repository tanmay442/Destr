import { NextResponse } from 'next/server';
import { getComposition } from '@/composition';
import { getRuntimeConfig } from '@/lib/config/runtime';

export async function GET() {
  const comp = getComposition();
  const checks: Record<string, boolean> = {
    runtimeConfig: false,
    database: false,
  };

  try {
    await getRuntimeConfig();
    checks.runtimeConfig = true;
  } catch {
    checks.runtimeConfig = false;
  }

  try {
    await comp.db.execute('SELECT 1');
    checks.database = true;
  } catch {
    checks.database = false;
  }

  const healthy = Object.values(checks).every(Boolean);
  return NextResponse.json(
    { status: healthy ? 'healthy' : 'degraded', checks },
    { status: healthy ? 200 : 503 },
  );
}
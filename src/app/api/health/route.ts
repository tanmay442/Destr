import { NextResponse } from 'next/server';
import { getComposition } from '@/composition';
import { getRuntimeConfig } from '@/lib/config/runtime';

export async function GET() {
  const comp = getComposition();
  const checks: Record<string, 'ok' | string> = {};

  try {
    await getRuntimeConfig();
    checks.runtimeConfig = 'ok';
  } catch (e) {
    checks.runtimeConfig = String(e);
  }

  try {
    await comp.db.execute('SELECT 1');
    checks.database = 'ok';
  } catch (e) {
    checks.database = String(e);
  }

  const healthy = Object.values(checks).every((v) => v === 'ok');
  return NextResponse.json(
    { status: healthy ? 'healthy' : 'degraded', checks },
    { status: healthy ? 200 : 503 },
  );
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.SKIP_ENV_VALIDATION !== '1') {
    const { validateEnv } = await import('./src/lib/env');
    const result = validateEnv();
    if (!result.ok) {
      throw new Error(result.message);
    }
  }
  const { startVectorDimensionCheck, startLocalRerankerCheck } = await import('@/composition');
  startVectorDimensionCheck();
  startLocalRerankerCheck();
}

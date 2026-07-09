export async function register() {
  if (process.env.NEXT_RUNTIME) {
    const { validateEnv } = await import('./src/lib/env');
    const result = validateEnv();
    if (!result.ok) {
      console.error(result.message);
      // fail fast in dev; prod logs and boots (per-adapter guards throw at call time)
      if (process.env.NODE_ENV === 'development') {
        throw new Error(result.message);
      }
    }
  }
}

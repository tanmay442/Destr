export async function register() {
  // Only run on the server (not in the browser).
  if (process.env.NEXT_RUNTIME) {
    const { validateEnv } = await import('./src/lib/env');
    const result = validateEnv();
    if (!result.ok) {
      console.error(result.message);
      // Fail fast in local dev so the developer sees the error immediately.
      // In production we log and keep booting; the per-adapter guards throw
      // at call time with specific messages.
      if (process.env.NODE_ENV === 'development') {
        throw new Error(result.message);
      }
    }
  }
}

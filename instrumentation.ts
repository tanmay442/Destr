export async function register() {
  if (process.env.NEXT_RUNTIME) {
    const { validateEnv } = await import('./src/lib/env');
    const result = validateEnv();
    if (!result.ok) {
      // Fail fast in every environment: a misconfigured deploy would otherwise
      // boot and serve confusing 500s once adapters hit the missing env vars.
      throw new Error(result.message);
    }
  }
}

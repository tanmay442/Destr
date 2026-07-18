export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startVectorDimensionCheck } = await import('@/composition');
    startVectorDimensionCheck();
  }
}

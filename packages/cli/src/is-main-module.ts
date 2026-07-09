// Returns true if this module is the program root (e.g. `tsx init.ts`),
// used by command files to gate their CLI entry blocks.
export function isMainModule(): boolean {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
}

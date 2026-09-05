import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeModernizationMeasurements } from './measurement-evidence';

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

function main(): void {
  const startedAt = performance.now();
  console.log('[baseline-measure] progress phase=validate-real-report status=started');
  const outputPath = writeModernizationMeasurements({ rootDirectory: process.cwd() });
  console.log(
    `[baseline-measure] progress phase=write-measurements status=completed elapsedMs=${Math.round(performance.now() - startedAt)}`,
  );
  console.log(`agent baseline measurements written to ${outputPath}`);
}

if (isMainModule()) main();

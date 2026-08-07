import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isMainModule(metaUrl: string = import.meta.url): boolean {
  try {
    if (!process.argv[1]) return false;
    const realArgv1 = realpathSync(process.argv[1]);
    const argvUrl = pathToFileURL(realArgv1).href;
    const realMetaUrl = pathToFileURL(realpathSync(new URL(metaUrl))).href;
    return argvUrl === realMetaUrl;
  } catch {
    return false;
  }
}


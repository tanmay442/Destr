import type { ContentParser, EnvSource, PdfValidator } from '@app/domain';
import { defaultProcessEnv } from '../config/env';
import { createProviderRegistry } from '../registry';

export type ContentParserProvider = (deps: { env: EnvSource }) => ContentParser;

export const contentParserRegistry = createProviderRegistry<ContentParserProvider>();

export function registerContentParserProvider(key: string, factory: ContentParserProvider): void {
  contentParserRegistry.register(key, factory);
}

export type PdfValidatorProvider = (deps: { env: EnvSource }) => PdfValidator;

export const pdfValidatorRegistry = createProviderRegistry<PdfValidatorProvider>();

export function registerPdfValidatorProvider(key: string, factory: PdfValidatorProvider): void {
  pdfValidatorRegistry.register(key, factory);
}

export function createContentParser(env: EnvSource = defaultProcessEnv): ContentParser {
  const factory = contentParserRegistry.get('unpdf');
  if (!factory) throw new Error('No content parser registered for "unpdf"');
  return factory({ env });
}

export function createPdfValidator(env: EnvSource = defaultProcessEnv): PdfValidator {
  const factory = pdfValidatorRegistry.get('unpdf');
  if (!factory) throw new Error('No PDF validator registered for "unpdf"');
  return factory({ env });
}

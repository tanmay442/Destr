import {
  requireAdminRoute,
  respond,
  MD_CHUNK_DELIMITER,
  UPLOAD_CHUNKED_MAX_MD_BYTES,
  UPLOAD_CHUNKED_MAX_PDF_BYTES,
} from '@/composition';
import { ValidationError } from '@app/domain';
import { readBoundedBytes } from '@/lib/http';

export const runtime = 'nodejs';

const UPLOAD_CHUNKED_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_CHUNKED_CHUNKS = 5000;
const MAX_PER_CHUNK_CHARS = 1_000_000;
const MAX_DELIMITER_LENGTH = 200;
const UPLOAD_CHUNKED_WINDOW_MS = 60_000;
const UPLOAD_CHUNKED_RATE_LIMIT = 10;

function inspectDelimited(text: string, delimiter: string): { chunks: number; maxSegment: number } {
  if (delimiter.length === 0) return { chunks: 1, maxSegment: text.length };
  let chunks = 1;
  let maxSegment = 0;
  let start = 0;
  while (true) {
    const idx = text.indexOf(delimiter, start);
    if (idx === -1) break;
    maxSegment = Math.max(maxSegment, idx - start);
    chunks += 1;
    start = idx + delimiter.length;
  }
  maxSegment = Math.max(maxSegment, text.length - start);
  return { chunks, maxSegment };
}

function isFileLike(value: FormDataEntryValue | null): value is File {
  return (
    value !== null &&
    typeof value === 'object' &&
    'size' in value &&
    typeof (value as { text?: unknown }).text === 'function' &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function'
  );
}

export async function POST(req: Request) {
  const auth = await requireAdminRoute(req);
  if (!auth.ok) return auth.response;
  const { session, comp } = auth;

  const limit = await comp.rateLimit(`upload-chunked:${session.user.id}`, {
    limit: UPLOAD_CHUNKED_RATE_LIMIT,
    windowMs: UPLOAD_CHUNKED_WINDOW_MS,
  });
  if (!limit.ok) {
    const retryAfter = Number.isFinite(limit.retryAfterMs) ? String(Math.ceil(limit.retryAfterMs / 1000)) : '60';
    return Response.json({ error: 'Rate limited' }, { status: 429, headers: { 'Retry-After': retryAfter } });
  }

  const bounded = await readBoundedBytes(req, UPLOAD_CHUNKED_MAX_TOTAL_BYTES);
  if (!bounded.ok) {
    return bounded.reason === 'too-large'
      ? respond(new ValidationError('Upload exceeds maximum size'))
      : respond(new ValidationError('Failed to read upload body'));
  }

  const formReq = new Request(req.url, {
    method: 'POST',
    headers: req.headers,
    body: Buffer.from(bounded.bytes),
  });

  let form: FormData;
  try {
    form = await formReq.formData();
  } catch {
    return respond(new ValidationError('Expected multipart/form-data'));
  }

  const mdFile = form.get('md');
  if (!isFileLike(mdFile) || mdFile.size === 0) {
    return respond(new ValidationError('Missing required "md" file field'));
  }
  if (mdFile.size > UPLOAD_CHUNKED_MAX_MD_BYTES) {
    return respond(new ValidationError(`Markdown exceeds ${UPLOAD_CHUNKED_MAX_MD_BYTES} bytes`));
  }

  const mdText = await mdFile.text();
  const mdName = (mdFile.name || 'upload.md').replace(/[\\/]/g, '_').slice(0, 200);
  const nameRaw = form.get('name');
  const name = ((typeof nameRaw === 'string' && nameRaw.trim()) || mdName).replace(/[\x00-\x1F]/g, '').slice(0, 200);
  const delimiterRaw = form.get('delimiter');
  const delimiter =
    typeof delimiterRaw === 'string' && delimiterRaw.trim() ? delimiterRaw.trim() : MD_CHUNK_DELIMITER;
  if (delimiter.length === 0 || delimiter.length > MAX_DELIMITER_LENGTH) {
    return respond(new ValidationError('Invalid delimiter'));
  }

  const { chunks, maxSegment } = inspectDelimited(mdText, delimiter);
  if (chunks > MAX_CHUNKED_CHUNKS) {
    return respond(new ValidationError(`Too many chunks (max ${MAX_CHUNKED_CHUNKS})`));
  }
  if (maxSegment > MAX_PER_CHUNK_CHARS) {
    return respond(new ValidationError(`Chunk exceeds ${MAX_PER_CHUNK_CHARS} characters`));
  }

  const pdfFile = form.get('pdf');
  let pdfBuffer: Buffer | undefined;
  let pdfFileName: string | undefined;
  if (isFileLike(pdfFile) && pdfFile.size > 0) {
    if (pdfFile.size > UPLOAD_CHUNKED_MAX_PDF_BYTES) {
      return respond(new ValidationError(`PDF exceeds ${UPLOAD_CHUNKED_MAX_PDF_BYTES} bytes`));
    }
    const arr = new Uint8Array(await pdfFile.arrayBuffer());
    pdfBuffer = Buffer.from(arr);
    pdfFileName = (pdfFile.name || `${name}.pdf`).replace(/[\\/]/g, '_').slice(0, 200);
  }

  const result = await comp.uploadChunkedMarkdown({
    fileName: name,
    mdText,
    delimiter,
    uploadedBy: session.user.id,
    pdfBuffer,
    pdfFileName,
    signal: req.signal,
  });
  if (!result.ok) return respond(result.error);

  return Response.json({
    documentId: result.value.documentId,
    chunks: result.value.chunks,
    status: result.value.status,
  });
}

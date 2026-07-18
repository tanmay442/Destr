import { requireAdminRoute, respond } from '@/composition';
import { ValidationError } from '@app/domain';
import { MD_CHUNK_DELIMITER, UPLOAD_CHUNKED_MAX_MD_BYTES, UPLOAD_CHUNKED_MAX_PDF_BYTES } from '../../../../../config/constants';

export const runtime = 'nodejs';

/**
 * POST /api/admin/upload-chunked
 *
 * Ingest pre-chunked Markdown. Accepts `multipart/form-data`:
 *   - `md` (file, required): the markdown document
 *   - `pdf` (file, optional): companion PDF stored for preview/download
 *   - `name` (string, optional): document name override (defaults to md filename)
 *   - `delimiter` (string, optional): chunk delimiter (defaults to MD_CHUNK_DELIMITER)
 *
 * The markdown is parsed (---chunk--- + title/page/source meta), embedded, and
 * written with its metadata into the `chunks` table. The uploader is the
 * authenticated admin.
 */
export async function POST(req: Request) {
  const auth = await requireAdminRoute(req);
  if (!auth.ok) return auth.response;
  const { session, comp } = auth;

  if (req.headers.get('content-length') && Number(req.headers.get('content-length')) > UPLOAD_CHUNKED_MAX_MD_BYTES + UPLOAD_CHUNKED_MAX_PDF_BYTES) {
    return respond(new ValidationError('Upload exceeds maximum size'));
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return respond(new ValidationError('Expected multipart/form-data'));
  }

  const mdFile = form.get('md');
  if (!(mdFile instanceof File) || mdFile.size === 0) {
    return respond(new ValidationError('Missing required "md" file field'));
  }
  if (mdFile.size > UPLOAD_CHUNKED_MAX_MD_BYTES) {
    return respond(new ValidationError(`Markdown exceeds ${UPLOAD_CHUNKED_MAX_MD_BYTES} bytes`));
  }

  const mdText = await mdFile.text();
  const mdName = (mdFile.name || 'upload.md').replace(/[\\/]/g, '_').slice(0, 200);
  const nameRaw = form.get('name');
  const name = (typeof nameRaw === 'string' && nameRaw.trim()) || mdName;
  const delimiterRaw = form.get('delimiter');
  const delimiter = typeof delimiterRaw === 'string' && delimiterRaw.trim() ? delimiterRaw.trim() : MD_CHUNK_DELIMITER;

  const pdfFile = form.get('pdf');
  let pdfBuffer: Buffer | undefined;
  let pdfFileName: string | undefined;
  if (pdfFile instanceof File && pdfFile.size > 0) {
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
  });
  if (!result.ok) return respond(result.error);

  return Response.json({
    documentId: result.value.documentId,
    chunks: result.value.chunks,
    status: result.value.status,
  });
}

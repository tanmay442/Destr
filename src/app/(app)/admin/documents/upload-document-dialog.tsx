'use client';

import { useEffect, useActionState, useRef, useState, type DragEvent } from 'react';
import { UploadCloud, FileText, RotateCw } from 'lucide-react';
import { uploadPdfAction, type UploadState } from '../actions';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';

const initial: UploadState = {};

export function UploadDocumentDialog() {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(uploadPdfAction, initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);

  useEffect(() => {
    if (state.status && inputRef.current) inputRef.current.value = '';
  }, [state.status]);

  useEffect(() => {
    if (state.error) toast.error(state.error);
  }, [state.error]);

  useEffect(() => {
    if (state.status) {
      toast.success(
        `${state.fileName}: ${state.status} (${state.chunks} chunks)`,
      );
    }
  }, [state.status, state.fileName, state.chunks]);

  useEffect(() => {
    if (!state.status) return undefined;
    const timer = setTimeout(() => {
      setOpen(false);
      setFileName(null);
      setFileSize(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [state.status]);

  async function acceptFile(file: File) {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('Only PDF files are supported.');
      return;
    }
    const firstBytes = await file.slice(0, 5).text();
    if (!firstBytes.startsWith('%PDF')) {
      toast.error('File is not a valid PDF');
      return;
    }
    const dt = new DataTransfer();
    dt.items.add(file);
    if (inputRef.current) {
      inputRef.current.files = dt.files;
    }
    setFileName(file.name);
    setFileSize(file.size);
  }

  function clearFile() {
    setFileName(null);
    setFileSize(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) await acceptFile(file);
  }

  function onDragOver(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragOver(true);
  }

  function onDragLeave(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragOver(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="documents-upload-trigger"
        >
          <UploadCloud data-icon="inline-start" />
          Upload
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload documentation</DialogTitle>
          <DialogDescription>
            Drop a PDF and we&apos;ll chunk, embed, and index it for RAG search.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <div
            className={cn(
              'rounded-lg border-2 border-dashed transition-colors',
              dragOver
                ? 'border-primary bg-primary/10'
                : fileName
                  ? 'border-border-subtle bg-surface-elevated'
                  : 'border-border-subtle bg-card hover:border-primary/60',
            )}
            data-testid="upload-dropzone"
          >
            <label
              htmlFor="upload-dialog-input"
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragEnter={onDragOver}
              onDragLeave={onDragLeave}
              className="flex cursor-pointer flex-col items-center justify-center gap-2 px-6 py-8 text-center"
            >
              {fileName ? (
                <div className="flex flex-col items-center gap-2 text-sm">
                  <FileText className="size-8 text-foreground" aria-hidden />
                  <span className="text-sm font-medium text-foreground">{fileName}</span>
                  {fileSize !== null ? (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {Math.max(1, Math.round(fileSize / 1024)).toLocaleString()} KB
                    </span>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                      e.preventDefault();
                      clearFile();
                    }}
                  >
                    <RotateCw data-icon="inline-start" />
                    Replace
                  </Button>
                </div>
              ) : (
                <>
                  <UploadCloud className="size-8 text-muted-foreground" aria-hidden />
                  <span className="text-sm font-medium text-foreground">
                    {dragOver ? 'Release to upload' : 'Drop a PDF here or click to browse'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    PDF only · up to 20 MB
                  </span>
                </>
              )}
            </label>
          </div>
          <input
            ref={inputRef}
            id="upload-dialog-input"
            type="file"
            name="file"
            accept="application/pdf"
            required
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) await acceptFile(f);
            }}
            data-testid="upload-input"
          />
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={pending || !fileName}
              data-testid="upload-submit"
            >
              {pending ? 'Uploading…' : 'Upload PDF'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

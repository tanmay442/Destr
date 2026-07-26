'use client';

import { useEffect, useActionState, useRef, useState, type DragEvent } from 'react';
import { uploadPdfAction, type UploadState } from '../actions';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { Upload } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
        <Button type="button" variant="outline" data-testid="documents-upload-trigger">
          <Upload data-icon="inline-start" />
          Upload document
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
              'cursor-pointer rounded-lg border-2 border-dashed transition-colors',
              dragOver
                ? 'border-primary bg-primary/10'
                : fileName
                  ? 'border bg-surface-elevated'
                  : 'border bg-card hover:border-primary/60',
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
                  <span className="text-base font-medium text-foreground">
                    {fileName}
                  </span>
                  {fileSize !== null ? (
                    <span className="text-xs text-muted-foreground">
                      {Math.max(1, Math.round(fileSize / 1024))} KB
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
                    Replace
                  </Button>
                </div>
              ) : (
                <>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="size-8 text-muted-foreground"
                    aria-hidden
                  >
                    <path d="M12 3v12" />
                    <path d="M7 8l5-5 5 5" />
                    <path d="M5 21h14" />
                  </svg>
                  <span className="text-sm font-medium text-foreground">
                    {dragOver
                      ? 'Release to upload'
                      : 'Drop a PDF here or click to browse'}
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
          <Button
            type="submit"
            disabled={pending || !fileName}
            data-testid="upload-submit"
          >
            {pending ? 'Uploading…' : 'Upload'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

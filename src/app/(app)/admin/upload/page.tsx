'use client';

import { useActionState, useRef, useState, type DragEvent } from 'react';
import { uploadPdfAction, type UploadState } from '../actions';

const initial: UploadState = {};

export default function UploadPage() {
  const [state, formAction, pending] = useActionState(uploadPdfAction, initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  async function acceptFile(file: File) {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setLocalError('Only PDF files are supported.');
      return;
    }
    const firstBytes = await file.slice(0, 5).text();
    if (!firstBytes.startsWith('%PDF')) {
      setLocalError('File is not a valid PDF');
      return;
    }
    setLocalError(null);
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
    setLocalError(null);
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
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-medium">Upload documentation</h2>
      <p className="text-sm text-foreground-muted">
        Drop a PDF and we&apos;ll chunk, embed, and index it for RAG search.
      </p>
      <form action={formAction} className="flex flex-col gap-3">
        <label
          htmlFor="upload-input"
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragEnter={onDragOver}
          onDragLeave={onDragLeave}
          className={[
            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors',
            dragOver
              ? 'border-accent bg-accent/10'
              : fileName
                ? 'border-border bg-surface-elevated'
                : 'border-border bg-surface hover:border-accent/60',
          ].join(' ')}
          data-testid="upload-dropzone"
        >
          {fileName ? (
            <div className="flex flex-col items-center gap-2 text-sm">
              <span className="text-base font-medium text-foreground">
                {fileName}
              </span>
              {fileSize !== null ? (
                <span className="text-xs text-foreground-muted">
                  {Math.max(1, Math.round(fileSize / 1024))} KB
                </span>
              ) : null}
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  clearFile();
                }}
                className="rounded-xl border border-border px-3 py-1 text-xs text-foreground-muted transition-colors hover:bg-surface hover:text-foreground"
              >
                Replace
              </button>
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
                className="h-8 w-8 text-foreground-muted"
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
              <span className="text-xs text-foreground-muted">
                PDF only · up to your server&apos;s request limit
              </span>
            </>
          )}
        </label>
        <input
          ref={inputRef}
          id="upload-input"
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
        {fileName ? (
          <span
            className="text-xs text-foreground-muted"
            data-testid="upload-filename"
          >
            Selected: {fileName}
          </span>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-xl bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50"
          data-testid="upload-submit"
        >
          {pending ? 'Uploading…' : 'Upload'}
        </button>
      </form>
      {localError ? (
        <div
          className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger"
          role="alert"
        >
          {localError}
        </div>
      ) : null}
      {state.error ? (
        <div
          className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger"
          role="alert"
        >
          {state.error}
        </div>
      ) : null}
      {state.status ? (
        <div
          className="rounded-xl border border-success/40 bg-success/10 p-3 text-sm text-success"
          data-testid="upload-success"
        >
          {state.fileName}: {state.status} ({state.chunks} chunks)
        </div>
      ) : null}
    </section>
  );
}

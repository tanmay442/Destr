'use client';

import { Loader2, RotateCw, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { FieldControl } from '../FieldControl';
import type { FieldDescriptor, Values } from '../types';

export function ChunkingTab({
  fieldMap,
  values,
  update,
  extraChunkingFields,
  embeddingModel,
  reingestPending,
  onReingest,
}: {
  fieldMap: Map<string, FieldDescriptor>;
  values: Values;
  update: (key: string, value: unknown) => void;
  extraChunkingFields: FieldDescriptor[];
  embeddingModel: unknown;
  reingestPending: boolean;
  onReingest: () => void;
}) {
  return (
    <div data-testid="group-Chunking" className="flex flex-col gap-6">
      <Card className="gap-0">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-col gap-1">
              <CardTitle className="text-base">Chunking strategy</CardTitle>
              <CardDescription>
                Configure document chunking parameters and parent-child window resolution.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={onReingest}
              disabled={reingestPending}
              data-testid="reingest-button"
            >
              {reingestPending ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <RotateCw data-icon="inline-start" />
              )}
              {reingestPending ? 'Re-ingesting…' : 'Re-ingest all'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-start gap-2.5 rounded-md border-l-2 border-accent-info bg-accent-info-soft/30 p-3 text-xs text-muted-foreground">
            <Info className="size-4 shrink-0 text-accent-info" aria-hidden />
            <div className="flex flex-col gap-1">
              <span>
                Embedding model:{' '}
                <span className="font-semibold text-foreground">
                  {String(embeddingModel ?? 'gemini-embedding-001')}
                </span>{' '}
                <span className="text-foreground-faint">
                  (requires re-ingest if changed via env)
                </span>
              </span>
              <span>
                <code className="font-mono text-foreground">INGEST_CHUNK_SIZE</code> and{' '}
                <code className="font-mono text-foreground">INGEST_CHUNK_OVERLAP</code> are
                environment-driven and applied at deploy time.
              </span>
            </div>
          </div>

          <Separator />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {fieldMap.has('chunkingStrategy') ? (
              <div className="sm:col-span-2">
                <FieldControl
                  field={fieldMap.get('chunkingStrategy')!}
                  value={values['chunkingStrategy']}
                  onChange={(v) => update('chunkingStrategy', v)}
                  onReset={() => update('chunkingStrategy', fieldMap.get('chunkingStrategy')!.default)}
                />
              </div>
            ) : null}
            {fieldMap.has('parentChunkSize') ? (
              <FieldControl
                field={fieldMap.get('parentChunkSize')!}
                value={values['parentChunkSize']}
                onChange={(v) => update('parentChunkSize', v)}
                onReset={() => update('parentChunkSize', fieldMap.get('parentChunkSize')!.default)}
              />
            ) : null}
            {fieldMap.has('childChunkSize') ? (
              <FieldControl
                field={fieldMap.get('childChunkSize')!}
                value={values['childChunkSize']}
                onChange={(v) => update('childChunkSize', v)}
                onReset={() => update('childChunkSize', fieldMap.get('childChunkSize')!.default)}
              />
            ) : null}
            {fieldMap.has('parentChildMode') ? (
              <FieldControl
                field={fieldMap.get('parentChildMode')!}
                value={values['parentChildMode']}
                onChange={(v) => update('parentChildMode', v)}
                onReset={() => update('parentChildMode', fieldMap.get('parentChildMode')!.default)}
              />
            ) : null}
            {fieldMap.has('parentChildWindow') ? (
              <FieldControl
                field={fieldMap.get('parentChildWindow')!}
                value={values['parentChildWindow']}
                onChange={(v) => update('parentChildWindow', v)}
                onReset={() => update('parentChildWindow', fieldMap.get('parentChildWindow')!.default)}
              />
            ) : null}
          </div>

          {extraChunkingFields.length > 0 ? (
            <>
              <Separator />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {extraChunkingFields.map((field) => (
                  <FieldControl
                    key={field.key}
                    field={field}
                    value={values[field.key]}
                    onChange={(v) => update(field.key, v)}
                    onReset={() => update(field.key, field.default)}
                  />
                ))}
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

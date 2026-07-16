'use client';

import { useEffect, useState } from 'react';
import { Loader2, RotateCw, AlertTriangle } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface SettingsPayload {
  chunkingStrategy: string;
  chunkingStrategies: string[];
  embeddingModel: string;
  envDriven: boolean;
  parentChunkSize: number;
  childChunkSize: number;
}

export function ReingestSettings() {
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ enqueued: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/settings');
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const data = (await res.json()) as SettingsPayload;
        if (!cancelled) setSettings(data);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load settings');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onReingest() {
    setPending(true);
    setResult(null);
    setActionError(null);
    try {
      const res = await fetch('/api/admin/reingest', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
      setResult({ enqueued: data.enqueued });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Re-ingest failed');
    } finally {
      setPending(false);
    }
  }

  if (loadError) {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>Could not load settings</AlertTitle>
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    );
  }

  if (!settings) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading settings…
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-medium">Ingest settings</h2>
        <p className="text-sm text-muted-foreground">
          Configure how documents are chunked and re-embed the corpus.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Chunking strategy</CardTitle>
          <CardDescription>
            Active at ingest time via the <code>CHUNKING_STRATEGY</code> environment
            variable.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="chunking-strategy">Strategy</Label>
            <Select value={settings.chunkingStrategy} disabled>
              <SelectTrigger id="chunking-strategy" className="w-[260px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {settings.chunkingStrategies.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Current value: <span className="font-medium">{settings.chunkingStrategy}</span>.
              Changing this requires editing <code>CHUNKING_STRATEGY</code> and redeploying —
              it is read at startup, not at runtime.
            </p>
          </div>

          <div className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Embedding model</span>
            <span className="font-medium">{settings.embeddingModel}</span>
            <p className="text-xs text-muted-foreground">
              A different embedding model also requires a full re-ingest, since stored vectors
              are tied to the model that produced them.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm sm:max-w-sm">
            <div className="grid gap-1">
              <span className="text-muted-foreground">Parent chunk size</span>
              <span className="font-medium">{settings.parentChunkSize}</span>
            </div>
            <div className="grid gap-1">
              <span className="text-muted-foreground">Child chunk size</span>
              <span className="font-medium">{settings.childChunkSize}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Re-ingest all documents</CardTitle>
          <CardDescription>
            Enqueues every non-deleted document for a full re-process with the current
            strategy and embedding model. Existing vectors are replaced atomically by the
            ingest worker.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert>
            <AlertTriangle />
            <AlertTitle>Strategy changes need a re-ingest</AlertTitle>
            <AlertDescription>
              Switching <code>CHUNKING_STRATEGY</code> or the embedding model leaves the
              existing chunks stale. Run a re-ingest after any such change for it to take
              effect.
            </AlertDescription>
          </Alert>

          <div>
            <Button onClick={onReingest} disabled={pending} data-testid="reingest-button">
              {pending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Re-ingesting…
                </>
              ) : (
                <>
                  <RotateCw className="size-4" />
                  Re-ingest All
                </>
              )}
            </Button>
          </div>

          {result && (
            <Alert data-testid="reingest-success">
              <AlertTitle>Re-ingest enqueued</AlertTitle>
              <AlertDescription>
                {result.enqueued} document{result.enqueued === 1 ? '' : 's'} queued for
                re-processing.
              </AlertDescription>
            </Alert>
          )}
          {actionError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Re-ingest failed</AlertTitle>
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

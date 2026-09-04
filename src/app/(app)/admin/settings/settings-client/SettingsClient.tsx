'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  Undo2,
  AlertTriangle,
  Shield,
  Cpu,
  Sliders,
} from 'lucide-react';
import { buildSystemPrompt } from '@app/application/prompt/build-system-prompt';
import { setDeep } from '@/components/admin/admin-helpers';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs';
import { toast } from '@/components/ui/sonner';
import { serialize, buildConfig, type FieldDescriptor, type Values } from './types';
import { PersonaTab } from './tabs/PersonaTab';
import { ChunkingTab } from './tabs/ChunkingTab';
import { RetrievalTab } from './tabs/RetrievalTab';

export function SettingsClient() {
  const [descriptor, setDescriptor] = useState<FieldDescriptor[] | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [values, setValues] = useState<Values>({});
  const [baseline, setBaseline] = useState<Values>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reingestPending, setReingestPending] = useState(false);
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [schemaRes, stateRes] = await Promise.all([
          fetch('/api/admin/settings/schema'),
          fetch('/api/admin/settings'),
        ]);
        if (!schemaRes.ok) throw new Error(`Descriptor request failed (${schemaRes.status})`);
        if (!stateRes.ok) throw new Error(`Settings request failed (${stateRes.status})`);
        const { fields } = (await schemaRes.json()) as { fields: FieldDescriptor[] };
        const { version: v } = (await stateRes.json()) as { version: number };
        if (cancelled) return;
        const initial: Values = {};
        for (const f of fields) initial[f.key] = f.current;
        setDescriptor(fields);
        setValues(initial);
        setBaseline(initial);
        setVersion(v);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load settings');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const changedKeys = useMemo(() => {
    return Object.keys(values).filter((key) => serialize(values[key]) !== serialize(baseline[key]));
  }, [values, baseline]);

  const preview = useMemo(() => {
    if (!descriptor) return '';
    try {
      return buildSystemPrompt(buildConfig(values), null);
    } catch {
      return '';
    }
  }, [descriptor, values]);

  const fieldMap = useMemo(() => {
    if (!descriptor) return new Map<string, FieldDescriptor>();
    const map = new Map<string, FieldDescriptor>();
    for (const f of descriptor) map.set(f.key, f);
    return map;
  }, [descriptor]);

  const embeddingModel = descriptor?.find((f) => f.key === 'embeddingModel')?.current;

  function update(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleCopyPrompt() {
    if (!preview) return;
    if (!navigator.clipboard?.writeText) {
      toast.error('Could not copy the prompt. Select it in the preview and copy manually.');
      return;
    }
    navigator.clipboard
      .writeText(preview)
      .then(() => {
        setCopiedPrompt(true);
        toast.success('System prompt copied to clipboard');
        setTimeout(() => setCopiedPrompt(false), 2000);
      })
      .catch(() => {
        toast.error('Could not copy the prompt. Select it in the preview and copy manually.');
      });
  }

  async function handleReingest() {
    setReingestPending(true);
    try {
      const res = await fetch('/api/admin/reingest', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
      toast.success(`${data.enqueued} document${data.enqueued === 1 ? '' : 's'} queued`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Re-ingest failed');
    } finally {
      setReingestPending(false);
    }
  }

  async function save(expectedVersion: number) {
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {};
      for (const key of changedKeys) setDeep(patch, key, values[key]);
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch, expectedVersion }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        setVersion(data.version as number);
        setBaseline({ ...values });
        setDiffOpen(false);
        setConflictVersion(null);
        toast.success('Settings saved');
        return;
      }
      if (res.status === 409) {
        setDiffOpen(false);
        setConflictVersion(data.version as number);
        return;
      }
      if (res.status === 422) {
        const reason = Array.isArray(data.locked)
          ? `Locked fields: ${data.locked.join(', ')}`
          : (data.reason ?? data.error ?? 'Unavailable value');
        toast.error(reason);
        return;
      }
      if (res.status === 429) {
        const retry = res.headers.get('Retry-After') ?? '5';
        toast.error(`Rate limited — retry in ${retry}s`);
        return;
      }
      toast.error(data.error ?? `Save failed (${res.status})`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
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

  if (!descriptor || version === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading settings…
      </div>
    );
  }

  const personaGridKeys = [
    'agentPersona.tone',
    'orgName',
    'audience',
    'customInstructions',
  ];

  const chunkingGridKeys = [
    'chunkingStrategy',
    'parentChunkSize',
    'childChunkSize',
    'parentChildMode',
    'parentChildWindow',
    'rsePenalty',
    'rseMaxSegmentChunks',
    'rseOverallMaxChunks',
    'rseMinSegmentValue',
  ];

  const retrievalKeys = [
    'retrievalMode',
    'hybridEnabled',
    'agentStepBudget',
    'agenticRetrieveLimit',
    'agenticMaxRetries',
    'similarityThreshold',
    'agenticQueryRewriteEnabled',
    'hallucinationCheckEnabled',
    'rerankerProvider',
    'auxModel',
    'judgeSampleRate',
    'answerCacheEnabled',
    'answerCacheTtlSec',
    'retrievalModeRolloutPercent',
    'captureQueryText',
  ];

  const extraPersonaFields = descriptor.filter(
    (f) =>
      f.group === 'Persona & Prompt' &&
      f.inputType &&
      !personaGridKeys.includes(f.key) &&
      f.key !== 'outOfScopeTopics' &&
      f.key !== 'agentPersona.name' &&
      f.key !== 'branding.title' &&
      f.key !== 'branding.description'
  );
  const extraChunkingFields = descriptor.filter(
    (f) => f.group === 'Chunking' && f.inputType && !chunkingGridKeys.includes(f.key)
  );
  const extraRetrievalFields = descriptor.filter(
    (f) => f.group === 'Retrieval' && f.inputType && !retrievalKeys.includes(f.key)
  );

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
          <p className="text-sm text-muted-foreground">Configure persona, guardrails, chunking, and retrieval options.</p>
        </div>
        <div className="flex items-center gap-2">
          {changedKeys.length > 0 ? (
            <Button variant="outline" size="sm" onClick={() => setValues({ ...baseline })} disabled={saving}>
              <Undo2 data-icon="inline-start" />
              Reset
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setDiffOpen(true)} disabled={changedKeys.length === 0 || saving} data-testid="review-save">
            Review &amp; Save
            {changedKeys.length > 0 ? (
              <Badge variant="secondary" className="ml-1 bg-primary-foreground/20 text-primary-foreground">
                {changedKeys.length}
              </Badge>
            ) : null}
          </Button>
        </div>
      </div>

      <Tabs defaultValue="persona" className="flex w-full flex-col gap-6">
        <div className="flex w-full scrollbar-none justify-start overflow-x-auto">
          <TabsList className="inline-flex h-auto w-auto max-w-full items-center gap-1 rounded-full border border-border-subtle bg-card p-1 shadow-sm">
            <TabsTrigger value="persona" className="gap-1.5 rounded-full px-4 py-1.5 text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm">
              <Shield className="size-3.5" data-icon="inline-start" />
              Persona &amp; Guardrails
            </TabsTrigger>
            <TabsTrigger value="chunking" className="gap-1.5 rounded-full px-4 py-1.5 text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm">
              <Cpu className="size-3.5" data-icon="inline-start" />
              Chunking Strategy
            </TabsTrigger>
            <TabsTrigger value="retrieval" className="gap-1.5 rounded-full px-4 py-1.5 text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm">
              <Sliders className="size-3.5" data-icon="inline-start" />
              Retrieval Strategy
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="persona" forceMount className="flex flex-col gap-6 data-[state=inactive]:hidden">
          <PersonaTab
            fieldMap={fieldMap}
            values={values}
            update={update}
            extraPersonaFields={extraPersonaFields}
            preview={preview}
            copiedPrompt={copiedPrompt}
            onCopyPrompt={handleCopyPrompt}
          />
        </TabsContent>

        <TabsContent value="chunking" forceMount className="flex flex-col gap-6 data-[state=inactive]:hidden">
          <ChunkingTab
            fieldMap={fieldMap}
            values={values}
            update={update}
            extraChunkingFields={extraChunkingFields}
            embeddingModel={embeddingModel}
            reingestPending={reingestPending}
            onReingest={handleReingest}
          />
        </TabsContent>

        <TabsContent value="retrieval" forceMount className="flex flex-col gap-6 data-[state=inactive]:hidden">
          <RetrievalTab
            fieldMap={fieldMap}
            values={values}
            update={update}
            extraRetrievalFields={extraRetrievalFields}
          />
        </TabsContent>
      </Tabs>

      {changedKeys.length > 0 ? (
        <div className="sticky bottom-4 z-40 flex flex-col items-stretch gap-3 rounded-lg border border-border-subtle bg-card/95 p-3 shadow-xl backdrop-blur-md sm:flex-row sm:items-center sm:justify-between sm:p-4">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Badge variant="default" className="h-5 px-1.5 text-[11px]">
              {changedKeys.length}
            </Badge>
            <span>
              unsaved change{changedKeys.length === 1 ? '' : 's'} pending review
            </span>
          </div>
          <div className="flex items-center gap-2 sm:justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setValues({ ...baseline })}
              disabled={saving}
            >
              Reset all
            </Button>
            <Button size="sm" onClick={() => setDiffOpen(true)} disabled={saving}>
              Review &amp; save
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog open={diffOpen} onOpenChange={setDiffOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review changes</DialogTitle>
            <DialogDescription>
              {changedKeys.length} field{changedKeys.length === 1 ? '' : 's'} will be updated.
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-80 flex-col gap-3 overflow-auto" data-testid="diff-list">
            {changedKeys.map((key) => {
              const field = descriptor.find((f) => f.key === key);
              return (
                <div
                  key={key}
                  className="border-b border-border-subtle pb-2 text-sm last:border-b-0"
                >
                  <div className="font-medium text-foreground">{field?.label ?? key}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="text-foreground-faint line-through">{serialize(baseline[key])}</span>
                    <span aria-hidden className="font-bold">→</span>
                    <span className="font-medium text-foreground">{serialize(values[key])}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiffOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={() => save(version)}
              disabled={saving}
              data-testid="confirm-save"
            >
              {saving ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
              Confirm &amp; save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={conflictVersion !== null}
        onOpenChange={(o) => !o && setConflictVersion(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Settings changed elsewhere</DialogTitle>
            <DialogDescription>
              Another admin saved version {conflictVersion} while you were editing. Re-apply your
              changes on top of the latest version?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConflictVersion(null)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              onClick={() => conflictVersion !== null && save(conflictVersion)}
              disabled={saving}
              data-testid="conflict-reapply"
            >
              {saving ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
              Re-apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

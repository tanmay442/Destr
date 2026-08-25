'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  RotateCw,
  AlertTriangle,
  Plus,
  Trash2,
  Undo2,
  Lock,
  Copy,
  Check,
  Shield,
  Cpu,
  Sliders,
  Pencil,
  Info,
} from 'lucide-react';
import type { AppConfig } from '@app/domain';
import { buildSystemPrompt } from '@app/application/prompt/build-system-prompt';
import { setDeep } from '@/components/admin/admin-helpers';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { toast } from '@/components/ui/sonner';

type InputType = 'text' | 'textarea' | 'select' | 'slider' | 'toggle' | 'number';

interface FieldDescriptor {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object';
  options?: string[];
  default: unknown;
  current: unknown;
  source: 'default' | 'db' | 'env-locked';
  readOnly?: boolean;
  available: boolean;
  unavailableReason?: string;
  group?: string;
  label?: string;
  inputType?: InputType;
  min?: number;
  max?: number;
  step?: number;
  rows?: number;
  helpText?: string;
  readOnlyReason?: string;
}

type OutOfScopeTopic = { topic: string; handling: string };
type Values = Record<string, unknown>;

function serialize(value: unknown): string {
  if (value === undefined) return '(unset)';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function buildConfig(values: Values): AppConfig {
  const nested: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) setDeep(nested, key, value);
  return nested as AppConfig;
}

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
        <TabsList className="h-auto w-full justify-start gap-1 bg-muted p-1 sm:h-10">
          <TabsTrigger value="persona" className="gap-2 data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Shield data-icon="inline-start" />
            Persona &amp; Guardrails
          </TabsTrigger>
          <TabsTrigger value="chunking" className="gap-2 data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Cpu data-icon="inline-start" />
            Chunking Strategy
          </TabsTrigger>
          <TabsTrigger value="retrieval" className="gap-2 data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Sliders data-icon="inline-start" />
            Retrieval Strategy
          </TabsTrigger>
        </TabsList>

        <TabsContent value="persona" forceMount className="flex flex-col gap-6 data-[state=inactive]:hidden">
          <div data-testid="group-Persona & Prompt" className="flex flex-col gap-6">
            <Card className="gap-0">
              <CardHeader>
                <CardTitle className="text-base">Persona configuration</CardTitle>
                <CardDescription>
                  Define agent persona details, tone, identity, and global custom instructions.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {fieldMap.has('agentPersona.tone') ? (
                  <FieldControl
                    field={fieldMap.get('agentPersona.tone')!}
                    value={values['agentPersona.tone']}
                    onChange={(v) => update('agentPersona.tone', v)}
                    onReset={() => update('agentPersona.tone', fieldMap.get('agentPersona.tone')!.default)}
                  />
                ) : null}
                {fieldMap.has('audience') ? (
                  <FieldControl
                    field={fieldMap.get('audience')!}
                    value={values['audience']}
                    onChange={(v) => update('audience', v)}
                    onReset={() => update('audience', fieldMap.get('audience')!.default)}
                  />
                ) : null}
                {fieldMap.has('orgName') ? (
                  <FieldControl
                    field={fieldMap.get('orgName')!}
                    value={values['orgName']}
                    onChange={(v) => update('orgName', v)}
                    onReset={() => update('orgName', fieldMap.get('orgName')!.default)}
                  />
                ) : null}
              </CardContent>
            </Card>

            {fieldMap.has('customInstructions') ? (
              <Card className="gap-0">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Custom instructions</CardTitle>
                  <CardDescription>Additional persona guidance injected into every prompt.</CardDescription>
                </CardHeader>
                <CardContent>
                  <FieldControl
                    field={fieldMap.get('customInstructions')!}
                    value={values['customInstructions']}
                    onChange={(v) => update('customInstructions', v)}
                    onReset={() => update('customInstructions', fieldMap.get('customInstructions')!.default)}
                  />
                </CardContent>
              </Card>
            ) : null}

            {extraPersonaFields.length > 0 ? (
              <Card className="gap-0">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Additional persona fields</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {extraPersonaFields.map((field) => (
                    <FieldControl
                      key={field.key}
                      field={field}
                      value={values[field.key]}
                      onChange={(v) => update(field.key, v)}
                      onReset={() => update(field.key, field.default)}
                    />
                  ))}
                </CardContent>
              </Card>
            ) : null}

            {fieldMap.has('outOfScopeTopics') ? (
              <OutOfScopeEditor
                field={fieldMap.get('outOfScopeTopics')!}
                value={(values['outOfScopeTopics'] as OutOfScopeTopic[]) ?? []}
                onChange={(v) => update('outOfScopeTopics', v)}
              />
            ) : null}

            <Card className="gap-0">
              <CardHeader>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex flex-col gap-1">
                    <CardTitle className="text-base">System prompt preview</CardTitle>
                    <CardDescription>
                      Assembled from in-flight edits (safety blocks fixed)
                    </CardDescription>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCopyPrompt}
                    data-testid="copy-prompt"
                  >
                    {copiedPrompt ? <Check /> : <Copy />}
                    {copiedPrompt ? 'Copied' : 'Copy prompt'}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <pre
                  data-testid="prompt-preview"
                  className="max-h-96 overflow-auto rounded-lg border border-border-subtle bg-surface-sunken p-4 font-mono text-xs whitespace-pre-wrap text-foreground"
                >
                  {preview}
                </pre>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="chunking" forceMount className="flex flex-col gap-6 data-[state=inactive]:hidden">
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
                    onClick={handleReingest}
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
        </TabsContent>

        <TabsContent value="retrieval" forceMount className="flex flex-col gap-6 data-[state=inactive]:hidden">
          <div data-testid="group-Retrieval" className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card className="gap-0">
                <CardHeader className="pb-4">
                  <CardTitle className="text-base">Search &amp; reranking</CardTitle>
                  <CardDescription>Vector threshold, hybrid, reranker and aux model.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  {['retrievalMode', 'hybridEnabled', 'similarityThreshold', 'rerankerProvider', 'auxModel'].map((key) => {
                    const field = fieldMap.get(key);
                    if (!field) return null;
                    return (
                      <FieldControl
                        key={field.key}
                        field={field}
                        value={values[field.key]}
                        onChange={(v) => update(field.key, v)}
                        onReset={() => update(field.key, field.default)}
                      />
                    );
                  })}
                </CardContent>
              </Card>

              <Card className="gap-0">
                <CardHeader className="pb-4">
                  <CardTitle className="text-base">Agentic controls</CardTitle>
                  <CardDescription>Step budget and per-step pipeline toggles.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-6">
                  <div className="flex flex-col gap-4">
                    <h4 className="text-sm font-medium text-foreground">Agentic budget limits</h4>
                    {['agentStepBudget', 'agenticRetrieveLimit', 'agenticMaxRetries'].map((key) => {
                      const field = fieldMap.get(key);
                      if (!field) return null;
                      return (
                        <FieldControl
                          key={field.key}
                          field={field}
                          value={values[field.key]}
                          onChange={(v) => update(field.key, v)}
                          onReset={() => update(field.key, field.default)}
                        />
                      );
                    })}
                  </div>
                  <Separator />
                  <div className="flex flex-col gap-4">
                    <h4 className="text-sm font-medium text-foreground">Agentic pipeline steps</h4>
                    {['agenticQueryRewriteEnabled', 'hallucinationCheckEnabled'].map((key) => {
                      const field = fieldMap.get(key);
                      if (!field) return null;
                      return (
                        <FieldControl
                          key={field.key}
                          field={field}
                          value={values[field.key]}
                          onChange={(v) => update(field.key, v)}
                          onReset={() => update(field.key, field.default)}
                        />
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card className="gap-0">
              <CardHeader className="pb-4">
                <CardTitle className="text-base">Cache &amp; rollout</CardTitle>
                <CardDescription>Response cache, rollout and query capture.</CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {['answerCacheEnabled', 'answerCacheTtlSec', 'retrievalModeRolloutPercent', 'captureQueryText'].map((key) => {
                  const field = fieldMap.get(key);
                  if (!field) return null;
                  return (
                    <FieldControl
                      key={field.key}
                      field={field}
                      value={values[field.key]}
                      onChange={(v) => update(field.key, v)}
                      onReset={() => update(field.key, field.default)}
                    />
                  );
                })}
              </CardContent>
            </Card>

            {extraRetrievalFields.length > 0 ? (
              <Card className="gap-0">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Additional retrieval</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {extraRetrievalFields.map((field) => (
                    <FieldControl
                      key={field.key}
                      field={field}
                      value={values[field.key]}
                      onChange={(v) => update(field.key, v)}
                      onReset={() => update(field.key, field.default)}
                    />
                  ))}
                </CardContent>
              </Card>
            ) : null}
          </div>
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

function FieldControl({
  field,
  value,
  onChange,
  onReset,
}: {
  field: FieldDescriptor;
  value: unknown;
  onChange: (value: unknown) => void;
  onReset: () => void;
}) {
  const id = `field-${field.key}`;
  const disabled = field.readOnly === true;
  const locked = field.readOnly === true;
  const changed = serialize(value) !== serialize(field.default);

  return (
    <div className="group/field flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label
          htmlFor={id}
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
        >
          {field.label ?? field.key}
          {locked ? (
            <Lock
              className="size-3 text-foreground-faint"
              aria-label={
                field.source === 'env-locked' ? 'Environment-locked' : 'Read-only'
              }
            />
          ) : null}
        </Label>
        {!disabled && changed ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onReset}
            className="opacity-0 transition-opacity duration-150 group-hover/field:opacity-100"
            data-testid={`reset-${field.key}`}
          >
            <Undo2 data-icon="inline-start" />
            Reset
          </Button>
        ) : null}
      </div>

      {field.inputType === 'textarea' ? (
        <Textarea
          id={id}
          rows={field.rows ?? 4}
          disabled={disabled}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}

      {field.inputType === 'text' ? (
        <Input
          id={id}
          disabled={disabled}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}

      {field.inputType === 'number' ? (
        <Input
          id={id}
          type="number"
          min={field.min}
          max={field.max}
          step={field.step}
          disabled={disabled}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      ) : null}

      {field.inputType === 'select' ? (
        <Select
          value={value === undefined || value === null ? '' : String(value)}
          onValueChange={(v) => onChange(typeof field.default === 'number' ? Number(v) : v)}
          disabled={disabled}
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {field.inputType === 'toggle' ? (
        <div className="flex items-center gap-3 pt-1">
          <Switch
            id={id}
            disabled={disabled}
            checked={Boolean(value)}
            onCheckedChange={onChange}
          />
          <span className="text-xs text-muted-foreground">
            {Boolean(value) ? 'Enabled' : 'Disabled'}
          </span>
        </div>
      ) : null}

      {field.inputType === 'slider' ? (
        <div className="flex items-center gap-4 pt-1">
          <Slider
            id={id}
            className="flex-1"
            {...(field.min === undefined ? {} : { min: field.min })}
            {...(field.max === undefined ? {} : { max: field.max })}
            {...(field.step === undefined ? {} : { step: field.step })}
            disabled={disabled}
            value={[
              typeof value === 'number' && Number.isFinite(value)
                ? value
                : field.min ?? 0,
            ]}
            onValueChange={(v) => onChange(v[0])}
          />
          <span className="w-12 text-right font-mono text-sm text-muted-foreground tabular-nums">
            {String(value)}
          </span>
        </div>
      ) : null}

      {field.helpText ? (
        <p className="text-xs leading-normal text-muted-foreground">{field.helpText}</p>
      ) : null}
      {locked ? (
        <p className="text-xs leading-normal text-muted-foreground">
          {field.readOnlyReason ??
            (field.source === 'env-locked'
              ? 'Locked by environment configuration.'
              : 'This value is managed by the system.')}
        </p>
      ) : null}
      {field.available === false && field.unavailableReason ? (
        <p className="text-xs leading-normal text-destructive">{field.unavailableReason}</p>
      ) : null}
    </div>
  );
}

function OutOfScopeEditor({
  field,
  value,
  onChange,
}: {
  field: FieldDescriptor;
  value: OutOfScopeTopic[];
  onChange: (value: OutOfScopeTopic[]) => void;
}) {
  const disabled = field.readOnly === true;
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  function updateAt(index: number, patch: Partial<OutOfScopeTopic>) {
    onChange(value.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function handleAdd() {
    const next = [...value, { topic: '', handling: '' }];
    onChange(next);
    setEditingIndex(next.length - 1);
  }

  const currentEditing = editingIndex !== null && value[editingIndex] ? value[editingIndex] : null;

  return (
    <Card className="gap-0">
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base">
              {field.label ?? 'Out-of-scope topics'}
            </CardTitle>
            <CardDescription>
              Define out-of-scope policies, declination summary, and routing rules.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={handleAdd}
            data-testid="oos-add"
          >
            <Plus data-icon="inline-start" />
            Add policy
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {value.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-subtle py-8 text-center text-sm text-muted-foreground">
            No out-of-scope policies configured. Click &quot;Add policy&quot; to define a topic rule.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border-subtle">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-1/4">Topic</TableHead>
                  <TableHead>Action summary / handling</TableHead>
                  <TableHead className="w-20 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {value.map((item, index) => (
                  <TableRow key={index} data-testid="oos-item">
                    <TableCell className="w-1/4 font-medium text-foreground">
                      {item.topic || <span className="text-foreground-faint italic">Untitled</span>}
                    </TableCell>
                    <TableCell className="max-w-md text-muted-foreground">
                      <span className="line-clamp-2">
                        {item.handling || (
                          <span className="text-foreground-faint italic">No handling summary</span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="w-20 text-right">
                      <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity duration-150 group-hover/row:opacity-100">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => setEditingIndex(index)}
                          aria-label={`Edit ${item.topic || 'policy'}`}
                          title="Edit policy"
                        >
                          <Pencil />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          disabled={disabled}
                          onClick={() => {
                            onChange(value.filter((_, i) => i !== index));
                            if (editingIndex === index) setEditingIndex(null);
                          }}
                          aria-label={`Delete ${item.topic || 'policy'}`}
                          title="Delete policy"
                          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          data-testid={`oos-remove-${index}`}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Sheet
        open={editingIndex !== null}
        onOpenChange={(open) => !open && setEditingIndex(null)}
      >
        <SheetContent side="right" className="flex flex-col">
          <SheetHeader>
            <SheetTitle>
              {editingIndex !== null && value[editingIndex]?.topic
                ? `Edit policy: ${value[editingIndex].topic}`
                : 'Out-of-scope topic policy'}
            </SheetTitle>
            <SheetDescription>
              Specify the topic identifier and exact declination or routing guidelines for the agent.
            </SheetDescription>
          </SheetHeader>
          {currentEditing ? (
            <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="drawer-topic" className="text-xs font-medium text-muted-foreground">
                  Topic name
                </Label>
                <Input
                  id="drawer-topic"
                  placeholder="e.g. legal-advice"
                  value={currentEditing.topic}
                  onChange={(e) => updateAt(editingIndex!, { topic: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label
                  htmlFor="drawer-handling"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Action summary &amp; handling
                </Label>
                <Textarea
                  id="drawer-handling"
                  placeholder="e.g. Decline request &amp; open security ticket…"
                  rows={5}
                  className="min-h-[120px] leading-relaxed"
                  value={currentEditing.handling}
                  onChange={(e) => updateAt(editingIndex!, { handling: e.target.value })}
                />
              </div>
            </div>
          ) : null}
          <div className="flex items-center justify-end gap-2 border-t border-border-subtle p-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditingIndex(null)}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => setEditingIndex(null)}>
              Save
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </Card>
  );
}

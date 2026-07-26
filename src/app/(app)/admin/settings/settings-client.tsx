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
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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

function setDeep(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i]!;
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

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
    navigator.clipboard.writeText(preview);
    setCopiedPrompt(true);
    toast.success('System prompt copied to clipboard');
    setTimeout(() => setCopiedPrompt(false), 2000);
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
      <div className="flex items-center gap-2 text-sm text-zinc-400">
        <Loader2 className="size-4 animate-spin" />
        Loading settings…
      </div>
    );
  }

  const personaGridKeys = [
    'agentPersona.tone',
    'orgName',
    'orgShortName',
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
    'rerankerProvider',
    'gradeModel',
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
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800 pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Settings</h1>
          <p className="text-sm text-zinc-400">
            Configure persona, guardrails, chunking, and retrieval options. <span className="text-zinc-500">(v{version})</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          {changedKeys.length > 0 && (
            <Button
              variant="outline"
              onClick={() => setValues({ ...baseline })}
              disabled={saving}
              className="bg-zinc-900 border-zinc-800 hover:bg-zinc-800 text-zinc-300"
            >
              <Undo2 className="size-4 mr-1" />
              Reset
            </Button>
          )}
          <Button
            onClick={() => setDiffOpen(true)}
            disabled={changedKeys.length === 0 || saving}
            data-testid="review-save"
            className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200 font-medium"
          >
            Review &amp; Save {changedKeys.length > 0 ? `(${changedKeys.length})` : ''}
          </Button>
        </div>
      </div>

      {/* 3-Tab Main Layout */}
      <Tabs defaultValue="persona" className="w-full space-y-6">
        <TabsList className="grid w-full grid-cols-1 sm:grid-cols-3 max-w-2xl bg-zinc-900 border border-zinc-800">
          <TabsTrigger value="persona" className="flex items-center gap-2 data-[state=active]:bg-zinc-800 data-[state=active]:text-zinc-100 text-zinc-400">
            <Shield className="size-4" />
            <span>Persona &amp; Guardrails</span>
          </TabsTrigger>
          <TabsTrigger value="chunking" className="flex items-center gap-2 data-[state=active]:bg-zinc-800 data-[state=active]:text-zinc-100 text-zinc-400">
            <Cpu className="size-4" />
            <span>Chunking Strategy</span>
          </TabsTrigger>
          <TabsTrigger value="retrieval" className="flex items-center gap-2 data-[state=active]:bg-zinc-800 data-[state=active]:text-zinc-100 text-zinc-400">
            <Sliders className="size-4" />
            <span>Retrieval Strategy</span>
          </TabsTrigger>
        </TabsList>

        {/* TAB 1: Persona & Guardrails */}
        <TabsContent value="persona" forceMount className="data-[state=inactive]:hidden flex flex-col gap-8">
          <div data-testid="group-Persona & Prompt" className="flex flex-col gap-8">
            {/* Section 1: Persona Configuration */}
            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle className="text-base">Persona Configuration</CardTitle>
                <CardDescription>
                  Define agent persona details, tone, identity, and global custom instructions.
                </CardDescription>
              </CardHeader>
              <CardContent>
              {/* 2-Column Grid for Form Fields */}
              <div className="grid grid-cols-2 gap-4">
                {/* Row 1: Response Tone */}
                <div>
                  {fieldMap.has('agentPersona.tone') && (
                    <FieldControl
                      field={fieldMap.get('agentPersona.tone')!}
                      value={values['agentPersona.tone']}
                      onChange={(v) => update('agentPersona.tone', v)}
                      onReset={() => update('agentPersona.tone', fieldMap.get('agentPersona.tone')!.default)}
                    />
                  )}
                </div>
                <div>
                  {fieldMap.has('audience') && (
                    <FieldControl
                      field={fieldMap.get('audience')!}
                      value={values['audience']}
                      onChange={(v) => update('audience', v)}
                      onReset={() => update('audience', fieldMap.get('audience')!.default)}
                    />
                  )}
                </div>

                {/* Row 2: Organization Name | Short Name */}
                <div>
                  {fieldMap.has('orgName') && (
                    <FieldControl
                      field={fieldMap.get('orgName')!}
                      value={values['orgName']}
                      onChange={(v) => update('orgName', v)}
                      onReset={() => update('orgName', fieldMap.get('orgName')!.default)}
                    />
                  )}
                </div>
                <div>
                  {fieldMap.has('orgShortName') && (
                    <FieldControl
                      field={fieldMap.get('orgShortName')!}
                      value={values['orgShortName']}
                      onChange={(v) => update('orgShortName', v)}
                      onReset={() => update('orgShortName', fieldMap.get('orgShortName')!.default)}
                    />
                  )}
                </div>
              </div>
              </CardContent>
            </Card>

              {/* Full-width rows at bottom */}
              <div className="flex flex-col gap-4">
                {fieldMap.has('customInstructions') && (
                  <FieldControl
                    field={fieldMap.get('customInstructions')!}
                    value={values['customInstructions']}
                    onChange={(v) => update('customInstructions', v)}
                    onReset={() => update('customInstructions', fieldMap.get('customInstructions')!.default)}
                  />
                )}

                {extraPersonaFields.map((field) => (
                  <FieldControl
                    key={field.key}
                    field={field}
                    value={values[field.key]}
                    onChange={(v) => update(field.key, v)}
                    onReset={() => update(field.key, field.default)}
                  />
                ))}
              </div>

            {/* Section 2: Out-of-Scope Topics */}
            {fieldMap.has('outOfScopeTopics') && (
              <OutOfScopeEditor
                field={fieldMap.get('outOfScopeTopics')!}
                value={(values['outOfScopeTopics'] as OutOfScopeTopic[]) ?? []}
                onChange={(v) => update('outOfScopeTopics', v)}
              />
            )}

            {/* Section 3: Clean System Prompt Preview */}
            <Card className="bg-card border-border">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">System Prompt Preview</CardTitle>
                    <CardDescription>
                      Assembled from in-flight edits (safety blocks fixed)
                    </CardDescription>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCopyPrompt}
                    className="h-8 px-3 text-xs bg-zinc-900 border-border hover:bg-zinc-800 text-zinc-200 flex items-center gap-1.5"
                  >
                    {copiedPrompt ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
                    {copiedPrompt ? 'Copied' : 'Copy Prompt'}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <pre
                  data-testid="prompt-preview"
                  className="bg-surface-sunken border border-border-subtle rounded-lg p-4 font-mono text-xs text-zinc-300 max-h-96 overflow-auto whitespace-pre-wrap"
                >
                  {preview}
                </pre>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* TAB 2: Chunking Strategy */}
        <TabsContent value="chunking" forceMount className="data-[state=inactive]:hidden flex flex-col gap-6">
          <div data-testid="group-Chunking" className="flex flex-col gap-6">
            {/* Header & Re-ingest Button */}
            <Card className="bg-card border-border">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">Chunking Strategy</CardTitle>
                    <CardDescription>
                      Configure document chunking parameters and parent-child window resolution.
                    </CardDescription>
                  </div>
                  <Button
                    onClick={handleReingest}
                    disabled={reingestPending}
                    data-testid="reingest-button"
                    className="h-9 px-3 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-md border border-border flex items-center gap-2"
                  >
                    {reingestPending ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" />
                        Re-ingesting…
                      </>
                    ) : (
                      <>
                        <RotateCw className="size-3.5" />
                        Re-ingest All
                      </>
                    )}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {/* Environment Notice Banner — accent left border */}
                <div className="p-3 bg-accent-info-soft/30 border-l-2 border-accent-info rounded-r-md text-xs text-zinc-400 flex items-start gap-2.5">
                  <Info className="size-4 text-accent-info shrink-0 mt-0.5" />
                  <div className="flex flex-col gap-1">
                    <div>
                      Embedding model: <span className="font-semibold text-zinc-200">{String(embeddingModel ?? 'gemini-embedding-001')}</span> <span className="text-zinc-500">(requires re-ingest if changed via env)</span>
                    </div>
                    <div>
                      <code className="text-zinc-300">INGEST_CHUNK_SIZE</code> and <code className="text-zinc-300">INGEST_CHUNK_OVERLAP</code> are environment-driven and applied at deploy time.
                    </div>
                  </div>
                </div>

                {/* Form Fields */}
                <div className="flex flex-col gap-4 mt-4">
                  {/* Full Width Chunking Strategy Select */}
                  {fieldMap.has('chunkingStrategy') && (
                    <div className="w-full">
                      <FieldControl
                        field={fieldMap.get('chunkingStrategy')!}
                        value={values['chunkingStrategy']}
                        onChange={(v) => update('chunkingStrategy', v)}
                        onReset={() => update('chunkingStrategy', fieldMap.get('chunkingStrategy')!.default)}
                      />
                    </div>
                  )}

                  {/* Strict 2-Column Grid for Numerical Parameters */}
                  <div className="grid grid-cols-2 gap-4 mt-4">
                    {/* Row 1: Parent Chunk Size | Child Chunk Size */}
                    <div>
                      {fieldMap.has('parentChunkSize') && (
                        <FieldControl
                          field={fieldMap.get('parentChunkSize')!}
                          value={values['parentChunkSize']}
                          onChange={(v) => update('parentChunkSize', v)}
                          onReset={() => update('parentChunkSize', fieldMap.get('parentChunkSize')!.default)}
                        />
                      )}
                    </div>
                    <div>
                      {fieldMap.has('childChunkSize') && (
                        <FieldControl
                          field={fieldMap.get('childChunkSize')!}
                          value={values['childChunkSize']}
                          onChange={(v) => update('childChunkSize', v)}
                          onReset={() => update('childChunkSize', fieldMap.get('childChunkSize')!.default)}
                        />
                      )}
                    </div>

                    {/* Row 2: Parent/Child Resolve | Parent/Child Window */}
                    <div>
                      {fieldMap.has('parentChildMode') && (
                        <FieldControl
                          field={fieldMap.get('parentChildMode')!}
                          value={values['parentChildMode']}
                          onChange={(v) => update('parentChildMode', v)}
                          onReset={() => update('parentChildMode', fieldMap.get('parentChildMode')!.default)}
                        />
                      )}
                    </div>
                    <div>
                      {fieldMap.has('parentChildWindow') && (
                        <FieldControl
                          field={fieldMap.get('parentChildWindow')!}
                          value={values['parentChildWindow']}
                          onChange={(v) => update('parentChildWindow', v)}
                          onReset={() => update('parentChildWindow', fieldMap.get('parentChildWindow')!.default)}
                        />
                      )}
                    </div>
                  </div>

                  {/* Extra Chunking Fields */}
                  {extraChunkingFields.length > 0 && (
                    <div className="grid grid-cols-2 gap-4 mt-4">
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
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* TAB 3: Retrieval Strategy */}
        <TabsContent value="retrieval" forceMount className="data-[state=inactive]:hidden flex flex-col gap-6">
          <div data-testid="group-Retrieval" className="flex flex-col gap-6">
            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle className="text-base">Retrieval Settings</CardTitle>
                <CardDescription>
                  Fine-tune vector search threshold, agentic step limits, reranker provider, and response cache parameters.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Search & Reranking */}
                  <div className="flex flex-col gap-4">
                    <h4 className="text-sm font-medium text-zinc-200">Search &amp; Reranking</h4>
                    {['retrievalMode', 'hybridEnabled', 'similarityThreshold', 'rerankerProvider', 'gradeModel'].map((key) => {
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

                  {/* Agentic Budget Limits */}
                  <div className="flex flex-col gap-4">
                    <h4 className="text-sm font-medium text-zinc-200">Agentic Budget Limits</h4>
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
                </div>

                {/* Cache Settings — full width row */}
                <div className="mt-6 pt-6 border-t border-border">
                  <h4 className="text-sm font-medium text-zinc-200 mb-4">Cache Settings</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {['answerCacheEnabled', 'answerCacheTtlSec'].map((key) => {
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
                </div>

                {/* Rollout & Misc */}
                <div className="mt-6 pt-6 border-t border-border">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {['retrievalModeRolloutPercent', 'captureQueryText'].map((key) => {
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
                </div>

                {/* Extra retrieval fields */}
                {extraRetrievalFields.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6 pt-6 border-t border-border">
                    {extraRetrievalFields.map((field) => (
                      <FieldControl
                        key={field.key}
                        field={field}
                        value={values[field.key]}
                        onChange={(v) => update(field.key, v)}
                        onReset={() => update(field.key, field.default)}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      {/* Sticky Bottom Action Bar when there are unsaved edits */}
      {changedKeys.length > 0 && (
        <div className="sticky bottom-4 z-40 flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/95 p-4 shadow-xl backdrop-blur">
          <div className="text-sm text-zinc-200">
            <span className="font-semibold text-zinc-100">{changedKeys.length}</span> unsaved change{changedKeys.length === 1 ? '' : 's'} pending review
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setValues({ ...baseline })}
              disabled={saving}
              className="bg-zinc-900 border-zinc-800 text-zinc-300 hover:bg-zinc-800"
            >
              Reset All
            </Button>
            <Button size="sm" onClick={() => setDiffOpen(true)} disabled={saving} className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200">
              Review &amp; Save
            </Button>
          </div>
        </div>
      )}

      {/* Review & Save Diff Dialog */}
      <Dialog open={diffOpen} onOpenChange={setDiffOpen}>
        <DialogContent className="bg-zinc-950 border-zinc-800 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="text-zinc-100">Review changes</DialogTitle>
            <DialogDescription className="text-zinc-400">
              {changedKeys.length} field{changedKeys.length === 1 ? '' : 's'} will be updated.
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-80 flex-col gap-3 overflow-auto" data-testid="diff-list">
            {changedKeys.map((key) => {
              const field = descriptor.find((f) => f.key === key);
              return (
                <div key={key} className="text-sm border-b border-zinc-800 pb-2 last:border-0">
                  <div className="font-medium text-zinc-200">{field?.label ?? key}</div>
                  <div className="text-zinc-400 flex items-center gap-2 mt-0.5 text-xs">
                    <span className="line-through text-zinc-500">{serialize(baseline[key])}</span>
                    <span aria-hidden className="text-zinc-400 font-bold">→</span>
                    <span className="text-zinc-100 font-medium">{serialize(values[key])}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiffOpen(false)} disabled={saving} className="bg-zinc-900 border-zinc-800 text-zinc-300 hover:bg-zinc-800">
              Cancel
            </Button>
            <Button onClick={() => save(version)} disabled={saving} data-testid="confirm-save" className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200">
              {saving ? <Loader2 className="size-4 animate-spin mr-1" /> : null}
              Confirm &amp; Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 409 Conflict Resolution Dialog */}
      <Dialog open={conflictVersion !== null} onOpenChange={(o) => !o && setConflictVersion(null)}>
        <DialogContent className="bg-zinc-950 border-zinc-800 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="text-zinc-100">Settings changed elsewhere</DialogTitle>
            <DialogDescription className="text-zinc-400">
              Another admin saved version {conflictVersion} while you were editing. Re-apply your
              changes on top of the latest version?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConflictVersion(null)} disabled={saving} className="bg-zinc-900 border-zinc-800 text-zinc-300 hover:bg-zinc-800">
              Cancel
            </Button>
            <Button
              onClick={() => conflictVersion !== null && save(conflictVersion)}
              disabled={saving}
              data-testid="conflict-reapply"
              className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200"
            >
              {saving ? <Loader2 className="size-4 animate-spin mr-1" /> : null}
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
  const locked = field.source === 'env-locked';
  const changed = serialize(value) !== serialize(field.default);

  return (
    <div className="grid gap-1.5 group">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
          {field.label ?? field.key}
          {locked && <Lock className="size-3 text-zinc-500" aria-label="Environment-locked" />}
        </Label>
        {!disabled && changed && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onReset}
            className="h-5 px-1.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 opacity-0 group-hover:opacity-100 transition-opacity duration-150"
            data-testid={`reset-${field.key}`}
          >
            <Undo2 className="size-3 mr-1" />
            Reset
          </Button>
        )}
      </div>

      {field.inputType === 'textarea' && (
        <Textarea
          id={id}
          rows={field.rows ?? 4}
          disabled={disabled}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="px-3 py-2 text-sm bg-input-elevated border-border rounded-md text-zinc-200 placeholder:text-zinc-500 focus-visible:ring-1 focus-visible:ring-ring/50 font-normal"
        />
      )}

      {field.inputType === 'text' && (
        <Input
          id={id}
          disabled={disabled}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 px-3 py-2 text-sm bg-input-elevated border-border rounded-md text-zinc-200 placeholder:text-zinc-500 focus-visible:ring-1 focus-visible:ring-ring/50"
        />
      )}

      {field.inputType === 'number' && (
        <Input
          id={id}
          type="number"
          min={field.min}
          max={field.max}
          step={field.step}
          disabled={disabled}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          className="h-10 px-3 py-2 text-sm bg-input-elevated border-border rounded-md text-zinc-200 placeholder:text-zinc-500 focus-visible:ring-1 focus-visible:ring-ring/50"
        />
      )}

      {field.inputType === 'select' && (
        <Select
          value={(value as string) ?? ''}
          onValueChange={onChange}
          disabled={disabled}
        >
          <SelectTrigger id={id} className="w-full h-10 px-3 py-2 text-sm bg-input-elevated border-border rounded-md text-zinc-200 focus:ring-1 focus:ring-ring/50">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-card border-border text-zinc-200">
            {(field.options ?? []).map((opt) => (
              <SelectItem key={opt} value={opt} className="focus:bg-zinc-800 focus:text-zinc-100">
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {field.inputType === 'toggle' && (
        <div className="flex items-center gap-3 pt-1">
          <Switch
            id={id}
            disabled={disabled}
            checked={Boolean(value)}
            onCheckedChange={onChange}
          />
          <span className="text-xs text-zinc-400">
            {Boolean(value) ? 'Enabled' : 'Disabled'}
          </span>
        </div>
      )}

      {field.inputType === 'slider' && (
        <div className="flex items-center gap-4 pt-1">
          <Slider
            id={id}
            className="flex-1"
            min={field.min}
            max={field.max}
            step={field.step}
            disabled={disabled}
            value={[Number(value ?? field.min ?? 0)]}
            onValueChange={(v) => onChange(v[0])}
          />
          <span className="w-12 text-right text-sm tabular-nums text-zinc-400 font-mono">
            {String(value)}
          </span>
        </div>
      )}

      {field.helpText && <p className="text-xs text-zinc-400 leading-normal">{field.helpText}</p>}
      {locked && (
        <p className="text-xs text-zinc-400 leading-normal">
          {field.readOnlyReason ?? 'Locked by environment configuration.'}
        </p>
      )}
      {field.available === false && field.unavailableReason && (
        <p className="text-xs text-red-400 leading-normal">{field.unavailableReason}</p>
      )}
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
    <Card className="bg-card border-border">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">{field.label ?? 'Out-of-Scope Topics'}</CardTitle>
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
            className="h-8 px-3 text-xs bg-zinc-900 border-border hover:bg-zinc-800 text-zinc-200 flex items-center gap-1.5"
          >
            <Plus className="size-3.5" />
            Add Policy
          </Button>
        </div>
      </CardHeader>
      <CardContent>

      {/* Flat Vercel-style clean data table */}
      {value.length === 0 ? (
        <div className="py-8 text-center text-sm text-zinc-500">
          No out-of-scope policies configured. Click &quot;Add Policy&quot; to define a topic rule.
        </div>
      ) : (
        <div className="w-full overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-xs font-medium text-zinc-400">
                <th className="py-2.5 px-2 w-1/4 font-medium text-zinc-200">TOPIC</th>
                <th className="py-2.5 px-2 font-medium text-zinc-200">ACTION SUMMARY / HANDLING</th>
                <th className="py-2.5 px-2 w-20 text-right font-medium text-zinc-200">ACTIONS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {value.map((item, index) => (
                <tr key={index} data-testid="oos-item" className="group hover:bg-surface-elevated/50 transition-colors">
                  <td className="py-3 px-2 font-medium text-zinc-200 w-1/4 truncate">
                    {item.topic || <span className="text-zinc-500 italic">Untitled</span>}
                  </td>
                  <td className="py-3 px-2">
                    <div className="truncate max-w-md text-zinc-400">
                      {item.handling || <span className="text-zinc-500 italic">No handling summary</span>}
                    </div>
                  </td>
                  <td className="py-3 px-2 w-20 text-right">
                    <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 rounded-md transition-colors"
                        onClick={() => setEditingIndex(index)}
                        title="Edit policy"
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={disabled}
                        onClick={() => {
                          onChange(value.filter((_, i) => i !== index));
                          if (editingIndex === index) setEditingIndex(null);
                        }}
                        className="size-7 text-zinc-400 hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors"
                        data-testid={`oos-remove-${index}`}
                        title="Delete policy"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      </CardContent>

      {/* Slide-over Drawer (Sheet) for focused policy editing */}
      <Sheet open={editingIndex !== null} onOpenChange={(open) => !open && setEditingIndex(null)}>
        <SheetContent side="right" className="sm:max-w-md bg-card border-border text-zinc-100 flex flex-col">
          <SheetHeader className="pb-4 border-b border-zinc-800">
            <SheetTitle className="text-zinc-100">
              {editingIndex !== null && value[editingIndex]?.topic
                ? `Edit Policy: ${value[editingIndex].topic}`
                : 'Out-of-Scope Topic Policy'}
            </SheetTitle>
            <SheetDescription className="text-zinc-400">
              Specify the topic identifier and exact declination or routing guidelines for the agent.
            </SheetDescription>
          </SheetHeader>
          {currentEditing && (
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="drawer-topic" className="text-xs font-medium text-zinc-400">Topic Name</Label>
                <Input
                  id="drawer-topic"
                  placeholder="e.g. legal-advice"
                  value={currentEditing.topic}
                  onChange={(e) => updateAt(editingIndex!, { topic: e.target.value })}
                  className="h-10 px-3 py-2 text-sm border border-zinc-800 bg-zinc-900/50 text-zinc-200 placeholder:text-zinc-500"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="drawer-handling" className="text-xs font-medium text-zinc-400">Action Summary &amp; Handling</Label>
                <Textarea
                  id="drawer-handling"
                  placeholder="e.g. Decline request &amp; open security ticket..."
                  rows={5}
                  className="min-h-[120px] px-3 py-2 text-sm border border-zinc-800 bg-zinc-900/50 text-zinc-200 placeholder:text-zinc-500 leading-relaxed"
                  value={currentEditing.handling}
                  onChange={(e) => updateAt(editingIndex!, { handling: e.target.value })}
                />
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-3 border-t border-zinc-800 p-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditingIndex(null)}
              className="h-9 px-4 text-sm font-medium border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => setEditingIndex(null)}
              className="h-9 px-4 text-sm font-medium bg-zinc-100 text-zinc-900 hover:bg-zinc-200"
            >
              Save
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </Card>
  );
}

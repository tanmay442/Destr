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
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
  SheetFooter,
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
  TableHead,
  TableRow,
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
        <Loader2 className="size-4 animate-spin" />
        Loading settings…
      </div>
    );
  }

  const personaKeys = ['agentPersona.name', 'agentPersona.tone', 'orgName', 'orgShortName', 'audience', 'branding.title', 'branding.description'];
  const chunkingKeys = ['chunkingStrategy', 'parentChunkSize', 'childChunkSize', 'parentChildMode', 'parentChildWindow'];
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
    (f) => f.group === 'Persona & Prompt' && f.inputType && !personaKeys.includes(f.key) && f.key !== 'customInstructions' && f.key !== 'outOfScopeTopics'
  );
  const extraChunkingFields = descriptor.filter(
    (f) => f.group === 'Chunking' && f.inputType && !chunkingKeys.includes(f.key)
  );
  const extraRetrievalFields = descriptor.filter(
    (f) => f.group === 'Retrieval' && f.inputType && !retrievalKeys.includes(f.key)
  );

  return (
    <section className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">SETTINGS</h1>
          <p className="text-sm text-muted-foreground">
            Configure system persona, out-of-scope guardrails, chunking strategies, and retrieval options. (Version {version})
          </p>
        </div>
        <div className="flex items-center gap-3">
          {changedKeys.length > 0 && (
            <Button
              variant="outline"
              onClick={() => setValues({ ...baseline })}
              disabled={saving}
            >
              <Undo2 className="size-4 mr-1" />
              Reset
            </Button>
          )}
          <Button
            onClick={() => setDiffOpen(true)}
            disabled={changedKeys.length === 0 || saving}
            data-testid="review-save"
          >
            Review &amp; Save {changedKeys.length > 0 ? `(${changedKeys.length})` : ''}
          </Button>
        </div>
      </div>

      {/* 3-Tab Main Layout */}
      <Tabs defaultValue="persona" className="w-full space-y-6">
        <TabsList className="grid w-full grid-cols-1 sm:grid-cols-3 max-w-2xl">
          <TabsTrigger value="persona" className="flex items-center gap-2">
            <Shield className="size-4" />
            <span>Persona &amp; Guardrails</span>
          </TabsTrigger>
          <TabsTrigger value="chunking" className="flex items-center gap-2">
            <Cpu className="size-4" />
            <span>Chunking Strategy</span>
          </TabsTrigger>
          <TabsTrigger value="retrieval" className="flex items-center gap-2">
            <Sliders className="size-4" />
            <span>Retrieval Strategy</span>
          </TabsTrigger>
        </TabsList>

        {/* TAB 1: Persona & Guardrails */}
        <TabsContent value="persona" forceMount className="data-[state=inactive]:hidden flex flex-col gap-6">
          <div data-testid="group-Persona & Prompt" className="flex flex-col gap-6">
            {/* Persona Configuration Card */}
            <Card>
              <CardHeader>
                <CardTitle>Persona Configuration</CardTitle>
                <CardDescription>
                  Define agent persona details, tone, identity, and global custom instructions.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {personaKeys.map((key) => {
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

                {/* Custom Instructions */}
                {fieldMap.has('customInstructions') && (
                  <div className="pt-2">
                    <FieldControl
                      field={fieldMap.get('customInstructions')!}
                      value={values['customInstructions']}
                      onChange={(v) => update('customInstructions', v)}
                      onReset={() => update('customInstructions', fieldMap.get('customInstructions')!.default)}
                    />
                  </div>
                )}

                {/* Any extra persona fields */}
                {extraPersonaFields.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
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
                )}
              </CardContent>
            </Card>

            {/* Out-of-Scope Topics Card */}
            {fieldMap.has('outOfScopeTopics') && (
              <OutOfScopeEditor
                field={fieldMap.get('outOfScopeTopics')!}
                value={(values['outOfScopeTopics'] as OutOfScopeTopic[]) ?? []}
                onChange={(v) => update('outOfScopeTopics', v)}
              />
            )}

            {/* System Prompt Preview Card */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <div className="space-y-1">
                  <CardTitle>System Prompt Preview</CardTitle>
                  <CardDescription>
                    Status: Assembled from in-flight edits (Safety blocks fixed)
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyPrompt}
                  className="flex items-center gap-1.5"
                >
                  {copiedPrompt ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
                  {copiedPrompt ? 'Copied' : 'Copy Prompt'}
                </Button>
              </CardHeader>
              <CardContent>
                <pre
                  data-testid="prompt-preview"
                  className="max-h-96 overflow-auto rounded-md bg-muted/70 p-4 text-xs font-mono whitespace-pre-wrap border"
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
            <Card>
              <CardHeader>
                <CardTitle>Chunking Configuration</CardTitle>
                <CardDescription>
                  Configure document chunking parameters and parent-child window resolution.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-6">
                {/* Info banner */}
                <Alert variant="default" className="bg-muted/40 border-muted-foreground/20">
                  <Info className="size-4 text-muted-foreground" />
                  <AlertTitle className="text-sm font-medium">Environment &amp; Embedding Model</AlertTitle>
                  <AlertDescription className="text-xs text-muted-foreground">
                    Embedding model: <span className="font-semibold text-foreground">{String(embeddingModel ?? 'gemini-embedding-001')}</span> (Requires re-ingest if changed via env).
                    <br />
                    <code>INGEST_CHUNK_SIZE</code> and <code>INGEST_CHUNK_OVERLAP</code> are environment-driven and applied at deploy time.
                  </AlertDescription>
                </Alert>

                {/* Strategy field */}
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

                {/* Parent & Child Chunk Size */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {['parentChunkSize', 'childChunkSize'].map((key) => {
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

                {/* Parent/Child Resolve & Window */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {['parentChildMode', 'parentChildWindow'].map((key) => {
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

                {/* Extra chunking fields */}
                {extraChunkingFields.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
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
              </CardContent>
            </Card>

            {/* Re-ingest Corpus Card isolated in Chunking tab */}
            <ReingestCard />
          </div>
        </TabsContent>

        {/* TAB 3: Retrieval Strategy */}
        <TabsContent value="retrieval" forceMount className="data-[state=inactive]:hidden flex flex-col gap-6">
          <div data-testid="group-Retrieval" className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Retrieval Settings</CardTitle>
                <CardDescription>
                  Fine-tune vector search threshold, agentic step limits, reranker provider, and response cache parameters.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {retrievalKeys.map((key) => {
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

                {/* Extra retrieval fields */}
                {extraRetrievalFields.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
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
        <div className="sticky bottom-4 z-40 flex items-center justify-between rounded-lg border bg-background/95 p-4 shadow-lg backdrop-blur">
          <div className="text-sm">
            <span className="font-semibold text-foreground">{changedKeys.length}</span> unsaved change{changedKeys.length === 1 ? '' : 's'} pending review
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => setValues({ ...baseline })} disabled={saving}>
              Reset All
            </Button>
            <Button size="sm" onClick={() => setDiffOpen(true)} disabled={saving}>
              Review &amp; Save
            </Button>
          </div>
        </div>
      )}

      {/* Review & Save Diff Dialog */}
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
                <div key={key} className="text-sm border-b pb-2 last:border-0">
                  <div className="font-medium">{field?.label ?? key}</div>
                  <div className="text-muted-foreground flex items-center gap-2 mt-0.5 text-xs">
                    <span className="line-through">{serialize(baseline[key])}</span>
                    <span aria-hidden className="text-primary font-bold">→</span>
                    <span className="text-foreground font-medium">{serialize(values[key])}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiffOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => save(version)} disabled={saving} data-testid="confirm-save">
              {saving ? <Loader2 className="size-4 animate-spin mr-1" /> : null}
              Confirm &amp; Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 409 Conflict Resolution Dialog */}
      <Dialog open={conflictVersion !== null} onOpenChange={(o) => !o && setConflictVersion(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Settings changed elsewhere</DialogTitle>
            <DialogDescription>
              Another admin saved version {conflictVersion} while you were editing. Re-apply your
              changes on top of the latest version?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConflictVersion(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={() => conflictVersion !== null && save(conflictVersion)}
              disabled={saving}
              data-testid="conflict-reapply"
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
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="flex items-center gap-1.5 text-sm font-medium">
          {field.label ?? field.key}
          {locked && <Lock className="size-3 text-muted-foreground" aria-label="Environment-locked" />}
        </Label>
        {!disabled && changed && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onReset}
            className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground"
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
          className="font-normal"
        />
      )}

      {field.inputType === 'text' && (
        <Input
          id={id}
          disabled={disabled}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
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
        />
      )}

      {field.inputType === 'select' && (
        <Select
          value={(value as string) ?? ''}
          onValueChange={onChange}
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
      )}

      {field.inputType === 'toggle' && (
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
          <span className="w-12 text-right text-sm tabular-nums text-muted-foreground font-mono">
            {String(value)}
          </span>
        </div>
      )}

      {field.helpText && <p className="text-xs text-muted-foreground leading-normal">{field.helpText}</p>}
      {locked && (
        <p className="text-xs text-muted-foreground leading-normal">
          {field.readOnlyReason ?? 'Locked by environment configuration.'}
        </p>
      )}
      {field.available === false && field.unavailableReason && (
        <p className="text-xs text-destructive leading-normal">{field.unavailableReason}</p>
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
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>{field.label ?? 'Out-of-Scope Topics'}</CardTitle>
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
          className="flex items-center gap-1.5"
        >
          <Plus className="size-4" />
          Add Policy
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {value.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            No out-of-scope policies configured. Click &quot;Add Policy&quot; to define a topic rule.
          </div>
        ) : (
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead className="w-[30%]">TOPIC</TableHead>
                  <TableHead className="w-[50%]">ACTION SUMMARY / HANDLING</TableHead>
                  <TableHead className="w-[20%] text-right">ACTIONS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {value.map((item, index) => (
                  <TableRow key={index} data-testid="oos-item">
                    <TableCell className="font-medium align-top pt-3">
                      <Input
                        aria-label={`Topic ${index + 1}`}
                        placeholder="Topic name"
                        disabled={disabled}
                        value={item.topic}
                        onChange={(e) => updateAt(index, { topic: e.target.value })}
                        className="h-8 text-xs"
                      />
                    </TableCell>
                    <TableCell className="align-top pt-3">
                      <Textarea
                        aria-label={`Handling ${index + 1}`}
                        placeholder="Decline message or handling action..."
                        rows={1}
                        disabled={disabled}
                        value={item.handling}
                        onChange={(e) => updateAt(index, { handling: e.target.value })}
                        className="min-h-[32px] text-xs resize-none py-1.5"
                      />
                    </TableCell>
                    <TableCell className="text-right align-top pt-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2 text-xs"
                          onClick={() => setEditingIndex(index)}
                        >
                          <Pencil className="size-3.5 mr-1" />
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={disabled}
                          onClick={() => {
                            onChange(value.filter((_, i) => i !== index));
                            if (editingIndex === index) setEditingIndex(null);
                          }}
                          className="h-8 px-2 text-xs text-destructive hover:text-destructive"
                          data-testid={`oos-remove-${index}`}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Slide-over Drawer (Sheet) for focused policy editing */}
        <Sheet open={editingIndex !== null} onOpenChange={(open) => !open && setEditingIndex(null)}>
          <SheetContent side="right" className="sm:max-w-md">
            <SheetHeader>
              <SheetTitle>
                {editingIndex !== null && value[editingIndex]?.topic
                  ? `Edit Policy: ${value[editingIndex].topic}`
                  : 'Out-of-Scope Topic Policy'}
              </SheetTitle>
              <SheetDescription>
                Specify the topic identifier and exact declination or routing guidelines for the agent.
              </SheetDescription>
            </SheetHeader>
            {currentEditing && (
              <div className="flex flex-col gap-5 py-6">
                <div className="grid gap-2">
                  <Label htmlFor="drawer-topic">Topic Name</Label>
                  <Input
                    id="drawer-topic"
                    placeholder="e.g. security-incident"
                    value={currentEditing.topic}
                    onChange={(e) => updateAt(editingIndex!, { topic: e.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="drawer-handling">Action Summary &amp; Handling</Label>
                  <Textarea
                    id="drawer-handling"
                    placeholder="e.g. Decline request &amp; open security ticket..."
                    rows={6}
                    value={currentEditing.handling}
                    onChange={(e) => updateAt(editingIndex!, { handling: e.target.value })}
                  />
                </div>
              </div>
            )}
            <SheetFooter>
              <Button onClick={() => setEditingIndex(null)}>Done</Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </CardContent>
    </Card>
  );
}

function ReingestCard() {
  const [pending, setPending] = useState(false);

  async function onReingest() {
    setPending(true);
    try {
      const res = await fetch('/api/admin/reingest', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
      toast.success(`${data.enqueued} document${data.enqueued === 1 ? '' : 's'} queued`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Re-ingest failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Re-ingest Corpus</CardTitle>
        <CardDescription>
          Applies chunking &amp; embedding changes to existing documents in the repository.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button onClick={onReingest} disabled={pending} data-testid="reingest-button">
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin mr-1" />
              Re-ingesting…
            </>
          ) : (
            <>
              <RotateCw className="size-4 mr-1" />
              Re-ingest All
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

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

const GROUP_ORDER = ['Persona & Prompt', 'Retrieval', 'Chunking'];

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

  const groups = useMemo(() => {
    if (!descriptor) return [];
    const seen = new Map<string, FieldDescriptor[]>();
    for (const f of descriptor) {
      if (!f.group || !f.inputType) continue;
      const list = seen.get(f.group) ?? [];
      list.push(f);
      seen.set(f.group, list);
    }
    const names = [...seen.keys()].sort((a, b) => {
      const ia = GROUP_ORDER.indexOf(a);
      const ib = GROUP_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    return names.map((name) => ({ name, fields: seen.get(name)! }));
  }, [descriptor]);

  const embeddingModel = descriptor?.find((f) => f.key === 'embeddingModel')?.current;

  function update(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }));
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

  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-medium">Runtime settings</h2>
          <p className="text-sm text-muted-foreground">
            Editable configuration resolved from the settings descriptor. Version {version}.
          </p>
        </div>
        <Button
          onClick={() => setDiffOpen(true)}
          disabled={changedKeys.length === 0 || saving}
          data-testid="review-save"
        >
          Review &amp; Save {changedKeys.length > 0 ? `(${changedKeys.length})` : ''}
        </Button>
      </div>

      {groups.map((group) => (
        <Card key={group.name} data-testid={`group-${group.name}`}>
          <CardHeader>
            <CardTitle>{group.name}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {group.fields.map((field) =>
              field.key === 'outOfScopeTopics' ? (
                <OutOfScopeEditor
                  key={field.key}
                  field={field}
                  value={(values[field.key] as OutOfScopeTopic[]) ?? []}
                  onChange={(v) => update(field.key, v)}
                />
              ) : (
                <FieldControl
                  key={field.key}
                  field={field}
                  value={values[field.key]}
                  onChange={(v) => update(field.key, v)}
                  onReset={() => update(field.key, field.default)}
                />
              ),
            )}
            {group.name === 'Chunking' && (
              <div className="grid gap-1 text-sm">
                {embeddingModel != null && (
                  <p className="text-xs text-muted-foreground">
                    Embedding model: <span className="font-medium">{String(embeddingModel)}</span> —
                    changing it requires a full re-ingest.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  <code>INGEST_CHUNK_SIZE</code> and <code>INGEST_CHUNK_OVERLAP</code> are
                  environment-driven and applied at deploy time, not editable here.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>System prompt preview</CardTitle>
          <CardDescription>
            Assembled from your in-flight edits. Safety blocks are fixed and cannot be edited;
            custom instructions are appended after the guardrails.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre
            data-testid="prompt-preview"
            className="max-h-96 overflow-auto rounded-md bg-muted p-4 text-xs whitespace-pre-wrap"
          >
            {preview}
          </pre>
        </CardContent>
      </Card>

      <ReingestCard />

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
                <div key={key} className="text-sm">
                  <div className="font-medium">{field?.label ?? key}</div>
                  <div className="text-muted-foreground">
                    <span className="line-through">{serialize(baseline[key])}</span>{' '}
                    <span aria-hidden>→</span>{' '}
                    <span className="text-foreground">{serialize(values[key])}</span>
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
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              Confirm &amp; Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
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
        <Label htmlFor={id} className="flex items-center gap-1.5">
          {field.label ?? field.key}
          {locked && <Lock className="size-3 text-muted-foreground" aria-label="Environment-locked" />}
        </Label>
        {!disabled && changed && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onReset}
            data-testid={`reset-${field.key}`}
          >
            <Undo2 className="size-3" />
            Reset
          </Button>
        )}
      </div>

      {field.inputType === 'textarea' && (
        <Textarea
          id={id}
          rows={field.rows}
          disabled={disabled}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
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
          <SelectTrigger id={id} className="w-[260px]">
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
        <Switch
          id={id}
          disabled={disabled}
          checked={Boolean(value)}
          onCheckedChange={onChange}
        />
      )}

      {field.inputType === 'slider' && (
        <div className="flex items-center gap-4">
          <Slider
            id={id}
            className="max-w-sm"
            min={field.min}
            max={field.max}
            step={field.step}
            disabled={disabled}
            value={[Number(value ?? field.min ?? 0)]}
            onValueChange={(v) => onChange(v[0])}
          />
          <span className="w-12 text-sm tabular-nums text-muted-foreground">{String(value)}</span>
        </div>
      )}

      {field.helpText && <p className="text-xs text-muted-foreground">{field.helpText}</p>}
      {locked && (
        <p className="text-xs text-muted-foreground">
          {field.readOnlyReason ?? 'Locked by environment configuration.'}
        </p>
      )}
      {field.available === false && field.unavailableReason && (
        <p className="text-xs text-destructive">{field.unavailableReason}</p>
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

  function updateAt(index: number, patch: Partial<OutOfScopeTopic>) {
    onChange(value.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  return (
    <div className="grid gap-3">
      <Label>{field.label ?? 'Out-of-Scope Topics'}</Label>
      {value.map((item, index) => (
        <div key={index} className="grid gap-2 rounded-md border p-3" data-testid="oos-item">
          <Input
            aria-label={`Topic ${index + 1}`}
            placeholder="Topic"
            disabled={disabled}
            value={item.topic}
            onChange={(e) => updateAt(index, { topic: e.target.value })}
          />
          <Textarea
            aria-label={`Handling ${index + 1}`}
            placeholder="Handling"
            rows={2}
            disabled={disabled}
            value={item.handling}
            onChange={(e) => updateAt(index, { handling: e.target.value })}
          />
          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
              data-testid={`oos-remove-${index}`}
            >
              <Trash2 className="size-3" />
              Remove
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...value, { topic: '', handling: '' }])}
          data-testid="oos-add"
        >
          <Plus className="size-3" />
          Add topic
        </Button>
      </div>
    </div>
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
        <CardTitle>Re-ingest all documents</CardTitle>
        <CardDescription>
          Chunking and embedding changes only affect new uploads. Re-ingest to apply them to the
          existing corpus.
        </CardDescription>
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
  );
}

'use client';

import { Undo2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { serialize, type FieldDescriptor } from './types';

export function FieldControl({
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

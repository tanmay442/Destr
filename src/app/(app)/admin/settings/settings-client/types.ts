import type { AppConfig } from '@app/domain';
import { setDeep } from '@/components/admin/admin-helpers';

export type InputType = 'text' | 'textarea' | 'select' | 'slider' | 'toggle' | 'number';

export interface FieldDescriptor {
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

export type OutOfScopeTopic = { topic: string; handling: string };
export type Values = Record<string, unknown>;

export function serialize(value: unknown): string {
  if (value === undefined) return '(unset)';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function buildConfig(values: Values): AppConfig {
  const nested: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) setDeep(nested, key, value);
  return nested as AppConfig;
}

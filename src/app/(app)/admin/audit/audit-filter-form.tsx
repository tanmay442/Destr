'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ALL = '__all__';
const KINDS = ['document', 'ticket', 'user', 'settings'] as const;

export function AuditFilterForm({
  kind,
  action,
  actor,
  from,
  to,
}: {
  kind?: string;
  action?: string;
  actor?: string;
  from?: string;
  to?: string;
}) {
  const [kindValue, setKindValue] = useState(kind ?? '');
  return (
    <form
      className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-6"
      method="get"
      aria-label="Filter audit log"
    >
      <input type="hidden" name="kind" value={kindValue} />
      <Label className="sr-only" htmlFor="audit-filter-kind">
        Kind
      </Label>
      <Select value={kindValue} onValueChange={(v) => setKindValue(v === ALL ? '' : v)}>
        <SelectTrigger id="audit-filter-kind" data-testid="audit-filter-kind">
          <SelectValue placeholder="All kinds" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All kinds</SelectItem>
          {KINDS.map((k) => (
            <SelectItem key={k} value={k}>
              {k}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Label className="sr-only" htmlFor="audit-filter-action">
        Action
      </Label>
      <Input
        id="audit-filter-action"
        type="text"
        name="action"
        defaultValue={action ?? ''}
        placeholder="Action (e.g. upload)"
        className="bg-background"
      />
      <Label className="sr-only" htmlFor="audit-filter-actor">
        Actor
      </Label>
      <Input
        id="audit-filter-actor"
        type="text"
        name="actor"
        defaultValue={actor ?? ''}
        placeholder="Actor id"
        className="bg-background"
      />
      <Label className="sr-only" htmlFor="audit-filter-from">
        From date
      </Label>
      <Input
        id="audit-filter-from"
        type="date"
        name="from"
        defaultValue={from ?? ''}
        className="bg-background"
      />
      <Label className="sr-only" htmlFor="audit-filter-to">
        To date
      </Label>
      <Input
        id="audit-filter-to"
        type="date"
        name="to"
        defaultValue={to ?? ''}
        className="bg-background"
      />
      <Button type="submit">Filter</Button>
    </form>
  );
}

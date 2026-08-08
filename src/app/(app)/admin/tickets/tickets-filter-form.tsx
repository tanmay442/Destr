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
const ANY = '__any__';

export function TicketsFilterForm({
  statuses,
  users,
  status,
  assignee,
  search,
}: {
  statuses: readonly string[];
  users: { clerkUserId: string; name: string | null; email: string }[];
  status?: string | undefined;
  assignee?: string | undefined;
  search?: string | undefined;
}) {
  const [statusValue, setStatusValue] = useState(status ?? '');
  const [assigneeValue, setAssigneeValue] = useState(assignee ?? '');
  const [prevFilters, setPrevFilters] = useState({ status, assignee });

  if (prevFilters.status !== status || prevFilters.assignee !== assignee) {
    setPrevFilters({ status, assignee });
    setStatusValue(status ?? '');
    setAssigneeValue(assignee ?? '');
  }

  return (
    <form
      className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4"
      method="get"
      aria-label="Filter tickets"
    >
      <input type="hidden" name="status" value={statusValue} />
      <input type="hidden" name="assignee" value={assigneeValue} />
      <Label className="sr-only" htmlFor="tickets-filter-status">
        Status
      </Label>
      <Select
        value={statusValue}
        onValueChange={(v) => setStatusValue(v === ALL ? '' : v)}
      >
        <SelectTrigger
          id="tickets-filter-status"
          data-testid="tickets-filter-status"
          className="w-full"
        >
          <SelectValue placeholder="All statuses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All statuses</SelectItem>
          {statuses.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Label className="sr-only" htmlFor="tickets-filter-assignee">
        Assignee
      </Label>
      <Select
        value={assigneeValue}
        onValueChange={(v) => setAssigneeValue(v === ANY ? '' : v)}
      >
        <SelectTrigger
          id="tickets-filter-assignee"
          data-testid="tickets-filter-assignee"
          className="w-full"
        >
          <SelectValue placeholder="Any assignee" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Any assignee</SelectItem>
          {users.map((u) => (
            <SelectItem key={u.clerkUserId} value={u.clerkUserId}>
              {u.name ?? u.email}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Label className="sr-only" htmlFor="tickets-search">
        Search issue
      </Label>
      <Input
        id="tickets-search"
        type="search"
        name="q"
        key={search ?? ''}
        defaultValue={search ?? ''}
        placeholder="Search issue…"
        data-testid="tickets-search"
      />
      <Button type="submit" size="sm">
        Apply
      </Button>
    </form>
  );
}

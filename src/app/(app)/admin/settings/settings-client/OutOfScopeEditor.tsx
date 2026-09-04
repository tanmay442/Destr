'use client';

import { useState } from 'react';
import { Plus, Trash2, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import type { FieldDescriptor, OutOfScopeTopic } from './types';

export function OutOfScopeEditor({
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

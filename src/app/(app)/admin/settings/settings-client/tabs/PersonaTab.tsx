'use client';

import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { FieldControl } from '../FieldControl';
import { OutOfScopeEditor } from '../OutOfScopeEditor';
import type { FieldDescriptor, OutOfScopeTopic, Values } from '../types';

export function PersonaTab({
  fieldMap,
  values,
  update,
  extraPersonaFields,
  preview,
  copiedPrompt,
  onCopyPrompt,
}: {
  fieldMap: Map<string, FieldDescriptor>;
  values: Values;
  update: (key: string, value: unknown) => void;
  extraPersonaFields: FieldDescriptor[];
  preview: string;
  copiedPrompt: boolean;
  onCopyPrompt: () => void;
}) {
  return (
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
              onClick={onCopyPrompt}
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
  );
}

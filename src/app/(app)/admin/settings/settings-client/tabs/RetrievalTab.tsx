'use client';

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { FieldControl } from '../FieldControl';
import type { FieldDescriptor, Values } from '../types';

export function RetrievalTab({
  fieldMap,
  values,
  update,
  extraRetrievalFields,
}: {
  fieldMap: Map<string, FieldDescriptor>;
  values: Values;
  update: (key: string, value: unknown) => void;
  extraRetrievalFields: FieldDescriptor[];
}) {
  return (
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
  );
}

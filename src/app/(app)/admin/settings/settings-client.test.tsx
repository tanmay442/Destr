import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('@/components/ui/sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

import { SettingsClient } from './settings-client';

interface FieldFixture {
  key: string;
  type: string;
  options?: string[];
  default: unknown;
  current: unknown;
  source: string;
  readOnly?: boolean;
  available: boolean;
  unavailableReason?: string;
  group?: string;
  label?: string;
  inputType?: string;
  min?: number;
  max?: number;
  step?: number;
  rows?: number;
  helpText?: string;
}

function descriptor(): FieldFixture[] {
  return [
    { key: 'orgName', type: 'string', default: 'Acme', current: 'Acme', source: 'default', available: true, group: 'Persona & Prompt', label: 'Organization Name', inputType: 'text' },
    { key: 'agentPersona.tone', type: 'enum', options: ['friendly', 'formal'], default: 'friendly', current: 'friendly', source: 'default', available: true, group: 'Persona & Prompt', label: 'Response Tone', inputType: 'select' },
    { key: 'customInstructions', type: 'string', default: '', current: '', source: 'default', available: true, group: 'Persona & Prompt', label: 'Custom Instructions', inputType: 'textarea', rows: 4 },
    { key: 'outOfScopeTopics', type: 'array', default: [], current: [{ topic: 'legal', handling: 'decline' }], source: 'default', available: true, group: 'Persona & Prompt', label: 'Out-of-Scope Topics', inputType: 'textarea' },
    { key: 'similarityThreshold', type: 'number', default: 0.5, current: 0.5, source: 'default', available: true, group: 'Retrieval', label: 'Similarity Threshold', inputType: 'slider', min: 0, max: 1, step: 0.05 },
    { key: 'agenticQueryRewriteEnabled', type: 'boolean', default: true, current: true, source: 'default', available: true, group: 'Retrieval', label: 'Query Rewrite (agentic)', inputType: 'toggle', helpText: 'When off, the raw user query is used for retrieval (no LLM rewrite).' },
    { key: 'agenticChunkGradingEnabled', type: 'boolean', default: true, current: true, source: 'default', available: true, group: 'Retrieval', label: 'Chunk Grading (agentic)', inputType: 'toggle', helpText: 'When off, top 4 retrieved chunks are sent without grading and shown with a warning. Not cached.' },
    { key: 'hallucinationCheckEnabled', type: 'boolean', default: true, current: true, source: 'default', available: true, group: 'Retrieval', label: 'Hallucination Check', inputType: 'toggle', helpText: 'Warning: disabling lets unverified answers be shown and they won\u2019t be cached. Use only for debugging.' },
    { key: 'hybridEnabled', type: 'boolean', default: true, current: true, source: 'default', available: true, group: 'Retrieval', label: 'Hybrid Search', inputType: 'toggle' },
    { key: 'chunkingStrategy', type: 'enum', options: ['document-aware', 'semantic'], default: 'document-aware', current: 'document-aware', source: 'env-locked', readOnly: true, available: true, group: 'Chunking', label: 'Chunking Strategy', inputType: 'select' },
    { key: 'embeddingModel', type: 'string', default: 'gemini-embedding-001', current: 'gemini-embedding-001', source: 'default', readOnly: true, available: true },
  ];
}

function jsonResponse(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    headers: { get: () => null },
  } as unknown as Response;
}

let putBodies: Array<{ patch: unknown; expectedVersion: number }>;

function installFetch(putHandler: (call: number) => Response) {
  putBodies = [];
  let putCall = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/admin/settings/schema') return jsonResponse(200, { fields: descriptor() });
      if (url === '/api/admin/settings' && (!init || init.method === undefined || init.method === 'GET')) {
        return jsonResponse(200, { version: 1, values: {}, sources: {} });
      }
      if (url === '/api/admin/settings' && init?.method === 'PUT') {
        putBodies.push(JSON.parse(init.body as string));
        putCall += 1;
        return putHandler(putCall);
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

async function renderLoaded() {
  render(<SettingsClient />);
  await screen.findByText('Organization Name');
}

beforeEach(() => {
  installFetch(() => jsonResponse(200, { version: 2 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SettingsClient', () => {
  it('renders controls generated from the descriptor', async () => {
    await renderLoaded();
    expect(screen.getByLabelText('Organization Name')).toBeInTheDocument();
    expect(screen.getByText('Response Tone')).toBeInTheDocument();
    expect(screen.getByText('Similarity Threshold')).toBeInTheDocument();
    expect(screen.getByText('Hybrid Search')).toBeInTheDocument();
  });

  it('renders env-locked fields disabled', async () => {
    await renderLoaded();
    const trigger = document.querySelector('#field-chunkingStrategy');
    expect(trigger).toBeDisabled();
  });

  it('renders the agentic pipeline step toggles under their labeled sub-section', async () => {
    await renderLoaded();
    expect(screen.getByText('Agentic pipeline steps')).toBeInTheDocument();
    for (const label of ['Query Rewrite (agentic)', 'Chunk Grading (agentic)', 'Hallucination Check']) {
      const toggle = screen.getByLabelText(label);
      expect(toggle).not.toBeDisabled();
      expect(toggle).toBeChecked();
    }
    expect(screen.getByText(/top 4 retrieved chunks are sent without grading/i)).toBeInTheDocument();
    expect(screen.getByText(/disabling lets unverified answers be shown/i)).toBeInTheDocument();
    expect(screen.getByText(/the raw user query is used for retrieval/i)).toBeInTheDocument();
  });

  it('supports out-of-scope add and remove', async () => {
    await renderLoaded();
    expect(screen.getAllByTestId('oos-item')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('oos-add'));
    expect(screen.getAllByTestId('oos-item')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('oos-remove-1'));
    expect(screen.getAllByTestId('oos-item')).toHaveLength(1);
  });

  it('shows a diff preview of changed fields old to new', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('Organization Name'), { target: { value: 'Globex' } });
    fireEvent.click(screen.getByTestId('review-save'));
    const list = await screen.findByTestId('diff-list');
    expect(within(list).getByText('Acme')).toBeInTheDocument();
    expect(within(list).getByText('Globex')).toBeInTheDocument();
  });

  it('handles a 409 conflict then re-applies with the new version', async () => {
    installFetch((call) => (call === 1 ? jsonResponse(409, { version: 5 }) : jsonResponse(200, { version: 6 })));
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('Organization Name'), { target: { value: 'Globex' } });
    fireEvent.click(screen.getByTestId('review-save'));
    fireEvent.click(await screen.findByTestId('confirm-save'));
    fireEvent.click(await screen.findByTestId('conflict-reapply'));
    await waitFor(() => expect(putBodies).toHaveLength(2));
    expect(putBodies[0]!.expectedVersion).toBe(1);
    expect(putBodies[1]!.expectedVersion).toBe(5);
  });
});

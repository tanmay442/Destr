import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/components/ui/sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from '@/components/ui/sonner';
import { SettingsRevertButton } from './settings-revert-button';

function jsonResponse(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

const CHANGES = [
  { key: 'agentStepBudget', old: 8, new: 5 },
  { key: 'agentPersona.tone', old: 'friendly', new: 'formal' },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SettingsRevertButton', () => {
  it('re-applies the prior values via PUT with the current version', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { version: 7 }))
      .mockResolvedValueOnce(jsonResponse(200, { version: 8 }));

    render(<SettingsRevertButton changes={CHANGES} />);
    fireEvent.click(screen.getByTestId('settings-revert'));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Settings reverted'));
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/settings');
    const [, init] = fetchMock.mock.calls[1]!;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({
      patch: { agentStepBudget: 8, agentPersona: { tone: 'friendly' } },
      expectedVersion: 7,
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('shows an error toast when the PUT fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { version: 7 }))
      .mockResolvedValueOnce(jsonResponse(409, { error: 'Version conflict' }));

    render(<SettingsRevertButton changes={CHANGES} />);
    fireEvent.click(screen.getByTestId('settings-revert'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Version conflict'));
    expect(refresh).not.toHaveBeenCalled();
  });
});

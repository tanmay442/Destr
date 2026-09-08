import type { AgenticResultState } from '@app/domain';

export type ToolCallOutcomeKind = 'success' | 'no_match' | 'error' | 'degraded' | 'denied' | 'timeout' | 'cancelled' | 'outcome_unknown';

export interface ToolCallRecord {
  readonly toolName: string;
  readonly callId: string;
  readonly kind: ToolCallOutcomeKind;
  readonly resultState: AgenticResultState | null;
  readonly ticketCreated: boolean;
  readonly searchInfrastructureFailed: boolean;
  readonly uniqueEvidenceAdded: number;
  readonly durationMs: number;
}

export interface TurnDerivedState {
  readonly resultState: AgenticResultState | null;
  readonly outOfDomain: boolean;
  readonly isEmpty: boolean;
  readonly ticketCreated: boolean;
  readonly ticketId: string | null;
  readonly searchInfrastructureFailed: boolean;
  readonly searchResultStates: AgenticResultState[];
  readonly totalCalls: number;
  readonly callsByTool: Readonly<Record<string, number>>;
}

const EMPTY_STATE: TurnDerivedState = {
  resultState: null,
  outOfDomain: false,
  isEmpty: false,
  ticketCreated: false,
  ticketId: null,
  searchInfrastructureFailed: false,
  searchResultStates: [],
  totalCalls: 0,
  callsByTool: {},
};

export class TurnToolLedger {
  private readonly records: ToolCallRecord[] = [];
  private ticketId: string | null = null;

  record(entry: ToolCallRecord, ticketId?: string | null): void {
    this.records.push(entry);
    if (entry.ticketCreated && ticketId) this.ticketId = ticketId;
  }

  get calls(): readonly ToolCallRecord[] {
    return this.records;
  }

  countFor(toolName: string): number {
    return this.records.filter((record) => record.toolName === toolName).length;
  }

  derive(): TurnDerivedState {
    if (this.records.length === 0) return EMPTY_STATE;
    const searchResultStates: AgenticResultState[] = [];
    let searchInfrastructureFailed = false;
    let ticketCreated = false;
    let lastResultState: AgenticResultState | null = null;
    let outOfDomain = false;
    let isEmpty = false;
    const callsByTool: Record<string, number> = {};
    for (const record of this.records) {
      callsByTool[record.toolName] = (callsByTool[record.toolName] ?? 0) + 1;
      if (record.resultState) {
        searchResultStates.push(record.resultState);
        lastResultState = record.resultState;
      }
      if (record.searchInfrastructureFailed) searchInfrastructureFailed = true;
      if (record.ticketCreated) ticketCreated = true;
    }
    const lastSearch = [...this.records].reverse().find((record) => record.toolName === 'searchDocumentation');
    if (lastSearch) {
      if (lastSearch.kind === 'no_match' && !searchInfrastructureFailed) {
        outOfDomain = true;
        isEmpty = true;
      } else if (lastSearch.kind === 'success' || lastSearch.kind === 'degraded') {
        outOfDomain = false;
        isEmpty = false;
      } else if (lastSearch.kind === 'error') {
        outOfDomain = false;
        isEmpty = false;
      }
    }
    return {
      resultState: lastResultState,
      outOfDomain,
      isEmpty,
      ticketCreated,
      ticketId: this.ticketId,
      searchInfrastructureFailed,
      searchResultStates,
      totalCalls: this.records.length,
      callsByTool,
    };
  }
}

// Hue — FROZEN shared contract. Frontend, backend and evals build against these.
export interface Conversation {
  id: string; callId: string; startedAt: string; durationSec: number | null;
  caller: { name: string | null; phone: string | null }; site: string | null;
  status: 'completed' | 'in_progress' | 'dropped';
  sentiment: 'happy' | 'neutral' | 'frustrated' | 'distressed' | null;
  srCreated: boolean; srRecordId: string | null;
  evalStatus: 'passed' | 'flagged' | 'not_evaluated' | 'skipped';
  qualityScore: number | null; transcript: TranscriptTurn[];
}
export interface TranscriptTurn {
  performer: 'caller' | 'agent' | 'system'; message: string; at?: string; toolCall?: ToolCall;
}
export interface ToolCall {
  name: string; status: 'success' | 'failed' | 'not_called';
  resultRecordId?: string | null; error?: string | null;
}
export interface Scorecard {
  conversationId: string; latencyMs: number | null;
  sttAccuracy: number | null; ttsQuality: number | null; responseQuality: number | null;
}
export type CheckType = 'intended_action' | 'required_field' | 'entity_resolution'
  | 'escalation_sla' | 'scope_boundary' | 'flow_conformance' | 'communication_fidelity' | 'custom';
export interface Criterion {
  id: string; clauseRef: string; title: string; description: string;
  checkType: CheckType; layer: 'deterministic' | 'semantic';
  source: 'ai_drafted' | 'manual'; active: boolean;
}
export interface Deviation {
  id: string; conversationId: string; criterionId: string; clauseRef: string; summary: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  rootCause: 'agent' | 'data' | 'sow' | 'unknown';
  status: 'open' | 'correcting' | 'resolved' | 'routed_to_human'; detectedAt: string;
}
export interface Correction {
  id: string; deviationId: string; target: 'prompt' | 'mapping' | 'sow' | 'human';
  before: string; after: string;
  state: 'proposed' | 'approved' | 'applied' | 'verifying' | 'resolved' | 'rejected';
  recommendedAction?: string; assignee?: string | null; proposedAt: string;
}

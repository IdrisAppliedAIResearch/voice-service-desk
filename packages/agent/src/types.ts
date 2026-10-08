import type pg from 'pg';
import type { PipelineName } from '@vsd/pipelines';
import type { KbChunk } from '@vsd/rag';

export type Msg =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; secret?: boolean } // secret: said during verification
  | { role: 'assistant'; content: string; toolCall?: ToolCall }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmResult {
  text: string;
  toolCalls: ToolCall[];
  malformed?: string;
}

export interface LlmAdapter {
  readonly name: string;
  complete(messages: Msg[], tools: ToolSpec[]): Promise<LlmResult>;
}

export type ScriptedResponse =
  | { say: string; tool?: undefined; raw?: undefined }
  | { say?: string; tool: { name: string; args?: Record<string, unknown>; rawArgs?: string }; raw?: undefined }
  | { raw: string };

export type SessionStatus = 'active' | 'locked' | 'escalated' | 'ended' | 'expired';

export interface Candidate {
  token: string;
  userId: string | null;
  isVip: boolean;
  decoyKey?: string;
}

export interface Session {
  id: string;
  channel: 'text' | 'voice';
  pipeline: PipelineName;
  state: string;
  status: SessionStatus;
  candidate?: Candidate;
  verified: boolean;
  verifiedAt?: Date;
  answersPassed: number;
  failedAttempts: number;
  questionsAsked: number;
  pendingQuestion?: { id: string; text: string };
  passedQuestionIds: string[];
  questionsPassed: boolean;
  pinPassed: boolean;
  otp?: { hash: string; expiresAt: Date; sends: number };
  vipTicketId?: number;
  history: Msg[];
  createdAt: Date;
  lastActivityAt: Date;
  endedAt?: Date;
}

export type AgentEvent =
  | { type: 'state'; pipeline: PipelineName; state: string; status: SessionStatus }
  | { type: 'tool'; name: string; outcome: string }
  | { type: 'tool_rejected'; name: string; reason: 'not_allowed' | 'invalid_args' | 'extra_call' }
  | { type: 'llm_retry'; reason: string }
  | { type: 'fallback'; reason: string }
  | { type: 'prerouter'; action: 'start_pipeline' | 'vip_handoff'; pipeline: PipelineName };

export interface TurnResult {
  reply: string;
  pipeline: PipelineName;
  state: string;
  status: SessionStatus;
  events: AgentEvent[];
}

export interface AgentDeps {
  db: pg.Pool;
  llm: LlmAdapter;
  now?: () => Date;
  retrieve?: (query: string) => Promise<KbChunk[]>;
}

export interface Agent {
  createSession(channel: 'text' | 'voice'): Promise<{ sessionId: string; reply: string; pipeline: PipelineName; state: string }>;
  handleTurn(sessionId: string, transcript: string): Promise<TurnResult>;
  getSession(sessionId: string): Session | undefined;
  sweep(): Promise<number>;
}

export class SessionNotFoundError extends Error {}
export class SessionExpiredError extends Error {}
export class SessionClosedError extends Error {}

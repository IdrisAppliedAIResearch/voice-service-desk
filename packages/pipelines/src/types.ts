export type PipelineName = 'triage' | 'general_help' | 'username_recovery' | 'password_reset' | 'ticket_status' | 'vip';
export type StartablePipeline = 'general_help' | 'username_recovery' | 'password_reset' | 'ticket_status';
export type ToolName =
  | 'start_pipeline'
  | 'lookup_account'
  | 'get_next_security_question'
  | 'verify_security_answer'
  | 'verify_vip_pin'
  | 'send_one_time_code'
  | 'verify_one_time_code'
  | 'recover_username'
  | 'reset_password'
  | 'search_kb'
  | 'get_ticket_status'
  | 'create_ticket'
  | 'escalate'
  | 'end_call';

export interface StateDef {
  tools: ToolName[];
  instruction: string | ((pendingQuestion?: string) => string);
  waitForCaller?: boolean;
  on?: Partial<Record<ToolName, Record<string, string>>>;
}

export interface VerificationPolicy {
  requiredAnswers: number;
  maxFailures: number;
  lockAccountMinutes: number;
  lockoutTicket: { priority: 'P1' | 'P3'; category: string };
}

export interface PipelineDef {
  label: string;
  initial: string;
  states: Record<string, StateDef>;
  verification?: VerificationPolicy;
  actionState?: string;
}

import type { PipelineDef, PipelineName, StateDef, ToolName } from './types';

export * from './types';

const ESCALATE = { escalate: { escalated: 'closing' } };
const SEARCH = { search_kb: { match: 'answer', no_match: 'no_match' } };

const closing: StateDef = {
  tools: ['end_call'],
  instruction: 'Tell the caller a specialist will follow up on the ticket that was opened, then end the call.',
};

const askQuestion: StateDef = {
  tools: ['get_next_security_question'],
  instruction: 'Call get_next_security_question.',
  on: { get_next_security_question: { asked: 'await_answer' } },
};

function awaitAnswer(complete: string, lockedOut: string): StateDef {
  return {
    tools: ['verify_security_answer'],
    waitForCaller: true,
    instruction: (question) =>
      `Ask this security question exactly, unless you just did: "${question}". When the caller answers, call verify_security_answer with only their answer, word for word, without the words around it.`,
    on: { verify_security_answer: { pass: 'ask_question', fail: 'ask_question', complete, locked_out: lockedOut } },
  };
}

function accountPipeline(
  name: 'username_recovery' | 'password_reset' | 'ticket_status',
  identifier: string,
  actionState: string,
  action: ToolName,
  done: string,
): PipelineDef {
  return {
    label: name,
    initial: 'collect_identifier',
    actionState,
    verification: { requiredAnswers: 2, maxFailures: 3, lockAccountMinutes: 15, lockoutTicket: { priority: 'P3', category: 'account-verification' } },
    states: {
      collect_identifier: {
        tools: ['lookup_account', 'escalate', 'end_call'],
        instruction: `Ask for the caller's ${identifier} and call lookup_account with only that identifier, word for word, without the words around it.`,
        on: { lookup_account: { found: 'ask_question' }, ...ESCALATE },
      },
      ask_question: askQuestion,
      await_answer: awaitAnswer(actionState, 'locked'),
      [actionState]: { tools: [action], instruction: `Call ${action}.`, on: { [action]: { done: 'done' } } },
      done: { tools: ['start_pipeline', 'create_ticket', 'escalate', 'end_call'], instruction: done, on: ESCALATE },
      locked: {
        tools: ['end_call'],
        instruction: 'Tell the caller you could not verify their identity, a ticket has been opened, and someone will follow up, then end the call.',
      },
      closing,
    },
  };
}

export const PIPELINES: Record<PipelineName, PipelineDef> = {
  triage: {
    label: 'triage',
    initial: 'greet',
    states: {
      greet: {
        tools: ['start_pipeline', 'escalate', 'end_call'],
        instruction:
          'Find out what the caller needs and call start_pipeline with general_help, username_recovery, password_reset, or ticket_status, or call escalate if they want a person.',
        on: ESCALATE,
      },
      closing,
    },
  },
  general_help: {
    label: 'general_help',
    initial: 'answer',
    states: {
      answer: {
        tools: ['search_kb', 'create_ticket', 'start_pipeline', 'escalate', 'end_call'],
        instruction:
          "Call search_kb with the caller's question and answer only from the returned articles, using the newest one if they disagree, and offer a ticket if the problem is not solved.",
        on: { ...SEARCH, ...ESCALATE },
      },
      no_match: {
        tools: ['create_ticket', 'search_kb', 'start_pipeline', 'escalate', 'end_call'],
        instruction: 'Tell the caller the knowledge base has no answer for that and offer to open a ticket, calling create_ticket if they agree.',
        on: { ...SEARCH, ...ESCALATE },
      },
      closing,
    },
  },
  username_recovery: accountPipeline(
    'username_recovery',
    'work email or employee ID',
    'recover',
    'recover_username',
    'Read the username exactly as spelled in the tool result, say a copy was emailed to the address on file, and ask if there is anything else.',
  ),
  password_reset: accountPipeline(
    'password_reset',
    'username, work email, or employee ID',
    'reset',
    'reset_password',
    'Say where the temporary password was sent, that it must be changed at next sign-in, whether the account was unlocked, and ask if there is anything else.',
  ),
  ticket_status: accountPipeline(
    'ticket_status',
    'work email, employee ID, or username',
    'status',
    'get_ticket_status',
    "Summarize the caller's tickets from the tool result in plain sentences and ask if there is anything else.",
  ),
  vip: {
    label: 'account_verification',
    initial: 'ask_question',
    actionState: 'verified',
    verification: { requiredAnswers: 2, maxFailures: 2, lockAccountMinutes: 15, lockoutTicket: { priority: 'P1', category: 'executive-support' } },
    states: {
      ask_question: askQuestion,
      await_answer: awaitAnswer('collect_pin', 'failed'),
      collect_pin: {
        tools: ['verify_vip_pin'],
        waitForCaller: true,
        instruction: 'Ask the caller for their six-digit PIN and call verify_vip_pin with the digits they say.',
        on: { verify_vip_pin: { pass: 'send_code', fail: 'collect_pin', locked_out: 'failed' } },
      },
      send_code: {
        tools: ['send_one_time_code'],
        instruction: 'Call send_one_time_code.',
        on: { send_one_time_code: { sent: 'await_code', locked_out: 'failed' } },
      },
      await_code: {
        tools: ['verify_one_time_code', 'send_one_time_code'],
        waitForCaller: true,
        instruction:
          'Say a one-time code was texted to the phone number on file, ask the caller to read it back, and call verify_one_time_code with the digits, or send_one_time_code if they did not get it.',
        on: {
          verify_one_time_code: { pass: 'verified', fail: 'await_code', expired: 'send_code', locked_out: 'failed' },
          send_one_time_code: { sent: 'await_code', locked_out: 'failed' },
        },
      },
      verified: {
        tools: ['reset_password', 'recover_username', 'get_ticket_status', 'search_kb', 'create_ticket', 'escalate', 'end_call'],
        instruction: 'Verification is complete, so do what the caller asked with reset_password, recover_username, get_ticket_status, or search_kb.',
        on: ESCALATE,
      },
      failed: {
        tools: ['end_call'],
        instruction:
          'Tell the caller you could not complete verification and the support team will call them back at the number on file, without saying which step failed.',
      },
      closing,
    },
  },
};

export function nextState(pipeline: PipelineName, state: string, tool: ToolName, outcome: string): string | undefined {
  return PIPELINES[pipeline].states[state]?.on?.[tool]?.[outcome];
}

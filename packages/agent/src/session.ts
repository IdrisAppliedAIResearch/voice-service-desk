import { randomUUID } from 'node:crypto';
import { retrieve } from '@vsd/rag';
import { upsertSession, type Db } from '@vsd/db';
import { PIPELINES } from '@vsd/pipelines';
import { audit } from './tools';
import { FALLBACK_REPLY, runTurn } from './turn';
import { SessionClosedError, SessionExpiredError, SessionNotFoundError, type Agent, type AgentDeps, type Session } from './types';

export const GREETING = 'Thanks for calling the Contoso Health service desk. How can I help you today?';
export const SESSION_IDLE_MS = 10 * 60_000;

function persist(db: Db, s: Session): Promise<void> {
  return upsertSession(db, {
    id: s.id,
    channel: s.channel,
    pipeline: s.pipeline,
    state: s.state,
    candidate_user_id: s.candidate?.userId ?? null,
    verified: s.verified,
    verified_at: s.verifiedAt ?? null,
    failed_attempts: s.failedAttempts,
    status: s.status,
    created_at: s.createdAt,
    ended_at: s.endedAt ?? null,
  });
}

export function createAgent(deps: AgentDeps): Agent {
  const ctx: Required<AgentDeps> = {
    ...deps,
    now: deps.now ?? (() => new Date()),
    retrieve: deps.retrieve ?? ((query) => retrieve(deps.db, query)),
  };
  const { db, now } = ctx;
  // Verification state lives only here, so a new session always starts unverified.
  const sessions = new Map<string, { s: Session; queue: Promise<unknown> }>();
  const expiredIds = new Set<string>(); // still reported as expired after expiry drops the session
  const idle = (s: Session) => now().getTime() - s.lastActivityAt.getTime() > SESSION_IDLE_MS;

  async function expire(s: Session): Promise<void> {
    sessions.delete(s.id);
    expiredIds.add(s.id);
    s.status = 'expired';
    s.endedAt = now();
    await persist(db, s);
    await audit({ db, s }, 'session_expired');
  }

  return {
    async createSession(channel) {
      const t = now();
      const s: Session = {
        id: randomUUID(),
        channel,
        pipeline: 'triage',
        state: PIPELINES.triage.initial,
        status: 'active',
        verified: false,
        answersPassed: 0,
        failedAttempts: 0,
        questionsAsked: 0,
        passedQuestionIds: [],
        questionsPassed: false,
        pinPassed: false,
        history: [{ role: 'assistant', content: GREETING }],
        createdAt: t,
        lastActivityAt: t,
      };
      await persist(db, s);
      sessions.set(s.id, { s, queue: Promise.resolve() });
      await audit({ db, s }, 'session_started', { channel });
      return { sessionId: s.id, reply: GREETING, pipeline: s.pipeline, state: s.state };
    },

    async handleTurn(sessionId, transcript) {
      const entry = sessions.get(sessionId);
      if (!entry) throw expiredIds.has(sessionId) ? new SessionExpiredError('Session expired') : new SessionNotFoundError('Session not found');
      const turn = entry.queue.then(async () => {
        const { s } = entry;
        if (s.status === 'ended') throw new SessionClosedError('Session closed');
        if (s.status === 'expired') throw new SessionExpiredError('Session expired');
        if (idle(s)) {
          await expire(s);
          throw new SessionExpiredError('Session expired');
        }
        try {
          return await runTurn(ctx, s, transcript);
        } catch (e) {
          // History must still end on an assistant turn, or every later request breaks role alternation.
          if (s.history.at(-1)?.role !== 'assistant') s.history.push({ role: 'assistant', content: FALLBACK_REPLY });
          throw e;
        } finally {
          await persist(db, s);
        }
      });
      entry.queue = turn.catch(() => {});
      return turn;
    },

    getSession: (sessionId) => sessions.get(sessionId)?.s,

    async sweep() {
      let expired = 0;
      for (const { s } of [...sessions.values()]) {
        if (!idle(s)) continue;
        if (s.status === 'ended') sessions.delete(s.id);
        else {
          await expire(s);
          expired++;
        }
      }
      return expired;
    },
  };
}

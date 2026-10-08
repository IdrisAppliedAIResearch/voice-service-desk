export function up(pgm) {
  const dim = Number(process.env.EMBEDDING_DIM || 768);
  if (!Number.isInteger(dim) || dim < 1) {
    throw new Error(`EMBEDDING_DIM must be a positive integer, got "${process.env.EMBEDDING_DIM}"`);
  }
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;

    CREATE TABLE servicedesk.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      username text UNIQUE NOT NULL,
      email text UNIQUE NOT NULL,
      employee_id text UNIQUE NOT NULL,
      first_name text NOT NULL,
      last_name text NOT NULL,
      department text NOT NULL,
      title text NOT NULL,
      phone_last4 char(4) NOT NULL,
      is_vip boolean NOT NULL DEFAULT false,
      is_locked boolean NOT NULL DEFAULT false,
      locked_until timestamptz,
      must_change_password boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE servicedesk.security_questions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES servicedesk.users ON DELETE CASCADE,
      question_text text NOT NULL,
      answer_hash text NOT NULL,
      position smallint NOT NULL CHECK (position BETWEEN 1 AND 3),
      UNIQUE (user_id, position)
    );

    CREATE TABLE servicedesk.vip_profiles (
      user_id uuid PRIMARY KEY REFERENCES servicedesk.users ON DELETE CASCADE,
      pin_hash text NOT NULL,
      executive_assistant_name text NOT NULL,
      assistant_phone_last4 char(4) NOT NULL,
      callback_phone_last4 char(4) NOT NULL,
      concierge_queue text NOT NULL DEFAULT 'executive-support'
    );

    CREATE TABLE servicedesk.sessions (
      id uuid PRIMARY KEY,
      channel text NOT NULL,
      pipeline text NOT NULL,
      state text NOT NULL,
      candidate_user_id uuid REFERENCES servicedesk.users,
      verified boolean NOT NULL DEFAULT false,
      verified_at timestamptz,
      failed_attempts int NOT NULL DEFAULT 0,
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz
    );

    CREATE TABLE servicedesk.tickets (
      id bigint GENERATED ALWAYS AS IDENTITY (START WITH 10001) PRIMARY KEY,
      user_id uuid REFERENCES servicedesk.users,
      session_id uuid REFERENCES servicedesk.sessions,
      priority text NOT NULL CHECK (priority IN ('P1', 'P2', 'P3', 'P4')),
      category text NOT NULL,
      summary text NOT NULL,
      status text NOT NULL DEFAULT 'open',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE servicedesk.outbox (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id uuid REFERENCES servicedesk.users,
      channel text NOT NULL CHECK (channel IN ('email', 'sms')),
      destination_masked text NOT NULL,
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE servicedesk.audit_log (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      session_id uuid,
      user_id uuid,
      event text NOT NULL,
      detail jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE servicedesk.kb_articles (
      id serial PRIMARY KEY,
      slug text UNIQUE NOT NULL,
      title text NOT NULL,
      body text NOT NULL,
      category text NOT NULL,
      topic text NOT NULL,
      updated_at date NOT NULL,
      tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', body), 'B')
      ) STORED
    );

    CREATE TABLE servicedesk.kb_chunks (
      id serial PRIMARY KEY,
      article_id int NOT NULL REFERENCES servicedesk.kb_articles ON DELETE CASCADE,
      chunk_index int NOT NULL,
      text text NOT NULL,
      tsv tsvector NOT NULL,
      embedding public.vector(${dim}),
      UNIQUE (article_id, chunk_index)
    );

    CREATE INDEX ON servicedesk.kb_articles USING gin (tsv);
    CREATE INDEX ON servicedesk.kb_chunks USING gin (tsv);
  `);
}

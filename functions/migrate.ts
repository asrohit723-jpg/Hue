/**
 * Schema migration for the Vigil app database.
 *
 * `facilio vibe db` exposes only CSV import, so DDL has to run through a
 * handler. Every statement is CREATE ... IF NOT EXISTS, making the whole
 * handler idempotent — safe to re-run on every deploy.
 *
 * Runtime facts this is written against (verified with a probe, not assumed):
 *   - env map supplies DB_USER, DB_PASSWORD, SCHEMA. It is DB_USER, NOT
 *     DB_USERNAME as the authoring guide's example shows.
 *   - db.query() is synchronous.
 *   - Table names must be unqualified; the schema goes in the constructor.
 *
 * Mirrors db/schema.sql. Keep the two in step.
 */
import StudioFunctions, { StudioDatabase } from '@facilio/studio-functions';

const server = new StudioFunctions({ name: 'migrate' });

const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS conversations (
     id TEXT PRIMARY KEY,
     call_id TEXT NOT NULL UNIQUE,
     started_at TIMESTAMPTZ NOT NULL,
     duration_sec INTEGER,
     caller_name TEXT,
     caller_phone TEXT,
     site_hint TEXT,
     status TEXT NOT NULL DEFAULT 'completed',
     sentiment TEXT,
     sr_claimed BOOLEAN NOT NULL DEFAULT FALSE,
     sr_number_claimed TEXT,
     cmms_sr_id TEXT,
     join_method TEXT NOT NULL DEFAULT 'none',
     join_confidence REAL NOT NULL DEFAULT 0,
     joined_at TIMESTAMPTZ,
     eval_status TEXT NOT NULL DEFAULT 'not_evaluated',
     quality_score INTEGER,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS conversations_started_idx ON conversations (started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS conversations_eval_idx ON conversations (eval_status)`,
  `CREATE INDEX IF NOT EXISTS conversations_srid_idx ON conversations (cmms_sr_id)`,

  `CREATE TABLE IF NOT EXISTS transcript_turns (
     id BIGSERIAL PRIMARY KEY,
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     turn_index INTEGER NOT NULL,
     performer TEXT NOT NULL,
     message TEXT NOT NULL DEFAULT '',
     at_offset TEXT,
     tool_name TEXT,
     tool_status TEXT,
     tool_args TEXT,
     tool_result TEXT,
     tool_record_id TEXT,
     tool_error TEXT,
     CONSTRAINT transcript_turn_uniq UNIQUE (conversation_id, turn_index)
   )`,
  `CREATE INDEX IF NOT EXISTS transcript_turns_convo_idx ON transcript_turns (conversation_id, turn_index)`,

  `CREATE TABLE IF NOT EXISTS sow_versions (
     id TEXT PRIMARY KEY,
     version TEXT NOT NULL UNIQUE,
     body TEXT NOT NULL,
     is_current BOOLEAN NOT NULL DEFAULT FALSE,
     updated_by TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS sow_clauses (
     id TEXT PRIMARY KEY,
     sow_version_id TEXT NOT NULL REFERENCES sow_versions(id) ON DELETE CASCADE,
     clause_ref TEXT NOT NULL,
     body TEXT NOT NULL,
     edited BOOLEAN NOT NULL DEFAULT FALSE,
     CONSTRAINT sow_clauses_version_ref_uniq UNIQUE (sow_version_id, clause_ref)
   )`,

  `CREATE TABLE IF NOT EXISTS criteria (
     id TEXT PRIMARY KEY,
     clause_ref TEXT NOT NULL,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     check_type TEXT NOT NULL,
     layer TEXT NOT NULL CHECK (layer IN ('deterministic','semantic')),
     source TEXT NOT NULL DEFAULT 'ai_drafted',
     active BOOLEAN NOT NULL DEFAULT TRUE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS criteria_active_idx ON criteria (active)`,

  `CREATE TABLE IF NOT EXISTS deviations (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     criterion_id TEXT NOT NULL,
     clause_ref TEXT NOT NULL DEFAULT '',
     summary TEXT NOT NULL,
     severity TEXT NOT NULL,
     root_cause TEXT NOT NULL DEFAULT 'unknown',
     status TEXT NOT NULL DEFAULT 'open',
     detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     detected_by TEXT NOT NULL DEFAULT 'deterministic'
       CHECK (detected_by IN ('deterministic','semantic')),
     checked_sr_id TEXT,
     evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
     CONSTRAINT deviations_convo_criterion_uniq UNIQUE (conversation_id, criterion_id)
   )`,
  `CREATE INDEX IF NOT EXISTS deviations_status_idx ON deviations (status, severity)`,
  `CREATE INDEX IF NOT EXISTS deviations_detected_idx ON deviations (detected_at DESC)`,

  `CREATE TABLE IF NOT EXISTS corrections (
     id TEXT PRIMARY KEY,
     deviation_id TEXT NOT NULL REFERENCES deviations(id) ON DELETE CASCADE,
     target TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     rationale TEXT NOT NULL DEFAULT '',
     before_text TEXT NOT NULL DEFAULT '',
     after_text TEXT NOT NULL DEFAULT '',
     state TEXT NOT NULL DEFAULT 'proposed',
     recommended_action TEXT,
     assignee TEXT,
     cmms_action JSONB NOT NULL DEFAULT '{}'::jsonb,
     proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     applied_at TIMESTAMPTZ,
     resolved_at TIMESTAMPTZ,
     applied_write_key TEXT UNIQUE,
     applied_record_id TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS corrections_state_idx ON corrections (state)`,
  `CREATE INDEX IF NOT EXISTS corrections_deviation_idx ON corrections (deviation_id)`,

  `CREATE TABLE IF NOT EXISTS eval_runs (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     finished_at TIMESTAMPTZ,
     outcome TEXT NOT NULL DEFAULT 'running',
     checks_run INTEGER NOT NULL DEFAULT 0,
     deviations_found INTEGER NOT NULL DEFAULT 0,
     error_message TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS eval_runs_convo_idx ON eval_runs (conversation_id, started_at DESC)`,
];

// NOTE ON MIGRATIONS: there are none, and there cannot be. The app's database
// role has no rights on its own schema — `ALTER TABLE` fails with "permission
// denied for schema schema_<org>_vibe_<hash>" — so no column can be added after
// the tables are created by CSV import. Anything that would want a new column
// has to be derived from the ones that exist instead. Live calls are marked by
// an `L-` id prefix rather than a `source` column for exactly this reason.

function connect() {
  // SCHEMA arrives in the env map and is the app's own provisioned schema
  // (vibe_<hash>). Without it there is no search_path and DDL fails with
  // "no schema has been selected to create in". It is a bare name, which is
  // what the constructor wants — never a schema_<orgid>_ prefixed one.
  return new StudioDatabase({
    userName: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    schema: process.env.SCHEMA,
  });
}

server.addHandler({
  name: 'up',
  description: 'Create every Vigil table and index. Idempotent.',
  parameters: {},
  execute: async () => {
    const db = connect();
    const applied: string[] = [];
    for (const sql of STATEMENTS) {
      db.query(sql);
      // Record a readable label rather than the whole statement.
      const m = /(?:TABLE|INDEX) IF NOT EXISTS ([A-Za-z0-9_]+)/.exec(sql);
      applied.push(m ? m[1] : 'statement');
    }
    const { rows } = db.query(
      `select table_name from information_schema.tables
        where table_schema = current_schema() order by table_name`,
    );
    return { statements: applied.length, tables: rows.map((r) => r.table_name) };
  },
});

server.addHandler({
  name: 'purgeSeeded',
  description:
    'Delete every seeded demo conversation, leaving only calls pulled from the helpdesk-call-logs connection. Destructive; requires confirm=1.',
  parameters: {
    confirm: { description: 'Must be 1. Guards against an accidental run.', type: 'number' },
  },
  execute: async (args) => {
    const db = connect();

    // Seeded calls are everything that is neither a live call (`L-` prefix) nor
    // the `__seed__` sentinel. The sentinel is NOT demo data — it is the single
    // row each table was created from by CSV import, and every query in the app
    // already excludes it. Deleting it would take the table's shape with it.
    // Both predicates take the alias: deviations and transcript_turns each have
    // their own `id`, so a half-qualified clause is ambiguous once joined.
    const seeded = (a: string) => `${a}.id <> '__seed__' and ${a}.id not like 'L-%'`;
    const target = seeded('conversations');

    const before = db.query(
      `select
         (select count(*) from conversations where ${target}) as conversations,
         (select count(*) from transcript_turns t
            where exists (select 1 from conversations c where c.id = t.conversation_id and ${seeded('c')})) as turns,
         (select count(*) from deviations d
            where exists (select 1 from conversations c where c.id = d.conversation_id and ${seeded('c')})) as deviations,
         (select count(*) from transcript_turns
            where conversation_id not in (select id from conversations)) as orphanTurns,
         (select count(*) from deviations
            where conversation_id not in (select id from conversations)) as orphanDeviations`,
    ).rows[0];

    if (Number(args.confirm) !== 1) {
      return {
        deleted: false,
        wouldDelete: before,
        note: 'Dry run. Re-run with confirm=1 to delete.',
      };
    }

    // Children are deleted explicitly, deepest first.
    //
    // schema.sql declares ON DELETE CASCADE on all of these, but the tables in
    // this database were created by CSV import, which carries no constraints —
    // so there are no foreign keys and nothing cascades. Deleting only the
    // parent rows leaves the transcripts and findings behind as orphans that no
    // JOIN returns, which looks like success while the data is still there.
    //
    // The `orphan` clauses also sweep up rows left behind by any earlier delete
    // that assumed the cascade was real.
    const orphan = (table: string) =>
      `delete from ${table} where conversation_id not in (select id from conversations)`;

    db.query(
      `delete from corrections where deviation_id in (
         select d.id from deviations d
          join conversations c on c.id = d.conversation_id
         where ${seeded('c')})`,
    );
    db.query(
      `delete from deviations where conversation_id in (select id from conversations where ${target})`,
    );
    db.query(
      `delete from transcript_turns where conversation_id in (select id from conversations where ${target})`,
    );
    db.query(`delete from conversations where ${target}`);

    // Sweep orphans, including any predating this run. Only the tables that
    // actually exist are touched — `criteria` and `eval_runs` are declared in
    // schema.sql but were never created, since the tables come from CSV import
    // and `migrate up` cannot run.
    // Deviations first, then corrections — sweeping corrections while orphaned
    // deviations still exist makes those corrections look reachable, and they
    // are stranded again the moment their deviation goes.
    db.query(orphan('deviations'));
    db.query(orphan('transcript_turns'));
    db.query('delete from corrections where deviation_id not in (select id from deviations)');

    const after = db.query(
      `select
         (select count(*) from conversations where id <> '__seed__') as conversations,
         (select count(*) from transcript_turns) as turns,
         (select count(*) from deviations where id <> '__seed__') as deviations,
         (select count(*) from corrections) as corrections`,
    ).rows[0];

    return { deleted: true, removed: before, remaining: after };
  },
});

server.addHandler({
  name: 'diag',
  description: 'Report the connected user and what it is allowed to do',
  parameters: {},
  execute: async () => {
    const db = connect();
    const { rows } = db.query(
      `select current_user as usr,
              session_user as sess,
              current_schema() as schema,
              has_schema_privilege(current_user, current_schema(), 'CREATE') as can_create,
              has_schema_privilege(current_user, current_schema(), 'USAGE')  as can_use`,
    );
    const roles = db.query(
      `select r.rolname from pg_roles r
        join pg_auth_members m on m.roleid = r.oid
        join pg_roles u on u.oid = m.member
       where u.rolname = current_user`,
    ).rows;
    return { info: rows[0] ?? null, memberOf: roles.map((r) => r.rolname), envSchema: process.env.SCHEMA };
  },
});

server.addHandler({
  name: 'status',
  description: 'List the tables that currently exist in the app database',
  parameters: {},
  execute: async () => {
    const db = connect();
    const { rows } = db.query(
      `select table_name from information_schema.tables
        where table_schema = current_schema() order by table_name`,
    );
    const schema = db.query('select current_schema() as s').rows[0]?.s ?? null;
    return { schema, tables: rows.map((r) => r.table_name) };
  },
});

server.execute();

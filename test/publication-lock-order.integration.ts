import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

interface LockFixture {
  databaseName: string;
  sql: (statement: string) => string;
  userId: string;
  queueId: string;
  intentId: string;
  claimToken: string;
  claimVersion: number;
  operation: 'begin' | 'release';
}
const literal = (value: string) => "'" + value.replace(/'/g, "''") + "'";

// Persistent psql sessions let the test hold real transaction locks. No database
// URL or provider credential is accepted: the caller has already proved this is
// the isolated local Supabase container.
function session(databaseName: string) {
  assert.match(databaseName, /^supabase_db_[a-zA-Z0-9_-]+$/);
  const child = spawn('docker', ['exec', '-i', databaseName, 'psql', '-X', '-qAt',
    '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate']);
  let stdout = '', stderr = '', exited = false;
  let pending: { marker: string; resolve: (value: string) => void; reject: (error: Error) => void } | undefined;
  const closed = new Promise<void>(resolve => {
    child.on('close', () => {
      exited = true;
      pending?.reject(new Error(stderr.trim() || 'Local SQL session closed'));
      pending = undefined;
      resolve();
    });
  });
  child.on('error', error => pending?.reject(error));
  child.stdin.on('error', error => pending?.reject(error));
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
  child.stdout.on('data', chunk => {
    stdout += String(chunk);
    if (pending) {
      const end = stdout.indexOf(pending.marker + '\n');
      if (end >= 0) {
        const value = stdout.slice(0, end).trim();
        stdout = stdout.slice(end + pending.marker.length + 1);
        const resolve = pending.resolve;
        pending = undefined;
        resolve(value);
      }
    }
  });
  return {
    query(statement: string): Promise<string> {
      assert.equal(exited, false, 'SQL session remains open');
      assert.equal(pending, undefined, 'one statement per SQL session at a time');
      const marker = 'barrier_' + randomUUID().replace(/-/g, '');
      return new Promise((resolve, reject) => {
        pending = { marker, resolve, reject };
        child.stdin.write(statement + ';\nSELECT ' + literal(marker) + ';\n');
      });
    },
    async close() {
      if (!exited) child.stdin.end('\n\\q\n');
      await closed;
    },
  };
}

export async function exercisePublicationLockOrder(f: LockFixture): Promise<void> {
  const gate = session(f.databaseName), owner = session(f.databaseName), contender = session(f.databaseName);
  const suffix = randomUUID().replace(/-/g, '');
  const gateKey = parseInt(suffix.slice(0, 7), 16);
  const ownerName = 'publication_owner_' + suffix;
  const contenderName = 'publication_contender_' + suffix;
  const contenderToken = randomUUID();
  const table = f.operation === 'begin' ? 'publication_attempts' : 'publication_intents';
  async function waitForLock(name: string, advisory = false) {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      const waiting = Number(f.sql("SELECT count(*) FROM pg_stat_activity WHERE application_name = "
        + literal(name) + " AND wait_event_type = 'Lock'"
        + (advisory ? " AND wait_event = 'advisory'" : '')));
      if (waiting === 1) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Expected controlled database lock was not reached');
  }
  try {
    // This fixture-only trigger pauses the owner after its initial row lock,
    // before the foreign-key check (begin) or queue projection (release).
    f.sql("CREATE FUNCTION public.fixture_publication_lock_barrier() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$ BEGIN "
      + "IF NEW.queue_item_id = " + literal(f.queueId) + "::uuid THEN PERFORM pg_catalog.pg_advisory_xact_lock(21475, " + gateKey + "); END IF; RETURN NEW; END; $$; "
      + "CREATE TRIGGER fixture_publication_lock_barrier BEFORE "
      + (f.operation === 'begin' ? 'INSERT' : 'UPDATE')
      + " ON public." + table + " FOR EACH ROW EXECUTE FUNCTION public.fixture_publication_lock_barrier();");
    await gate.query('SELECT pg_advisory_lock(21475, ' + gateKey + ')');
    for (const [connection, name] of [[owner, ownerName], [contender, contenderName]] as const) {
      await connection.query("SET application_name = " + literal(name)
        + "; SET statement_timeout = '15s'; SET deadlock_timeout = '100ms'; SET ROLE service_role");
    }
    const ownerSql = f.operation === 'begin'
      ? "SELECT id FROM public.begin_publication_dispatch(" + [
        literal(f.userId), literal(f.intentId), literal(f.claimToken), String(f.claimVersion),
        literal(randomUUID()), literal('fixture-account'), 'NULL', 'false',
      ].join(',') + ')'
      : "SELECT id FROM public.release_publication_claim(" + [
        literal(f.userId), literal(f.intentId), literal(f.claimToken), String(f.claimVersion),
        literal('fixture_predispatch_release'),
      ].join(',') + ')';
    const settle = (promise: Promise<string>) => promise.then(
      value => ({ ok: true, value, error: '' }),
      error => ({ ok: false, value: '', error: String(error) }),
    );
    const ownerResult = settle(owner.query(ownerSql));
    await waitForLock(ownerName, true);
    const contenderResult = settle(contender.query("SELECT id FROM public.claim_publication_intent("
      + [literal(f.userId), literal(f.queueId), literal(contenderToken), '120'].join(',') + ')'));
    await waitForLock(contenderName);
    await gate.query('SELECT pg_advisory_unlock(21475, ' + gateKey + ')');
    const results = await Promise.all([ownerResult, contenderResult]);
    assert.equal(results.some(result => result.error.includes('40P01')), false,
      'Controlled ' + f.operation + '/claim deadlock: ' + JSON.stringify(results));
    assert.equal(results[0].ok, true, JSON.stringify(results));
    if (f.operation === 'begin') {
      assert.equal(results[1].ok, false, 'Duplicate claim must not steal dispatched intent');
      assert.match(results[1].error, /P0001/);
      assert.equal(f.sql("SELECT state FROM public.publication_attempts WHERE queue_item_id = "
        + literal(f.queueId) + "::uuid"), 'dispatching');
    } else {
      assert.equal(results[1].ok, true, 'A safely released pre-dispatch claim may be acquired');
      assert.equal(f.sql("SELECT claim_token::text FROM public.publication_intents WHERE id = "
        + literal(f.intentId) + "::uuid"), contenderToken);
      assert.equal(Number(f.sql("SELECT claim_version FROM public.publication_intents WHERE id = "
        + literal(f.intentId) + "::uuid")), f.claimVersion + 1);
      assert.equal(Number(f.sql("SELECT count(*) FROM public.publication_attempts WHERE queue_item_id = "
        + literal(f.queueId) + "::uuid")), 0);
    }
  } finally {
    // Unlock even when a barrier assertion fails; statement timeouts bound all
    // remaining local work. Closing a session rolls back an unfinished command.
    await gate.close();
    await Promise.all([owner.close(), contender.close()]);
    f.sql('DROP TRIGGER IF EXISTS fixture_publication_lock_barrier ON public.' + table
      + '; DROP FUNCTION IF EXISTS public.fixture_publication_lock_barrier();');
  }
}

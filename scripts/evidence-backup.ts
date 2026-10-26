import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { arch, release, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSandbox } from '../apps/cli/src/sandbox.ts';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const fixturePath = 'fixtures/t20-backup-cases.json';
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: string[] };
const directory = join('artifacts', 't20-' + Date.now()); mkdirSync(directory, { recursive: true });
const startedAt = new Date().toISOString();
const observations: Record<string, unknown>[] = [];
let failed = false;
const evidenceGaps: string[] = [];
for (const scenario of fixture.cases) {
  const path = join(directory, scenario); mkdirSync(path);
  if (scenario.startsWith('project-output-') && process.platform !== 'win32') {
    const reason = 'controlled-project-output-host-unavailable-' + process.platform;
    if (!evidenceGaps.includes(reason)) evidenceGaps.push(reason);
    observations.push({ scenario,passed: null,reason }); continue;
  }
  const sandbox = createSandbox();
  let outputRoot: string | undefined;
  const commands: Record<string, unknown>[] = [];
  const run = (name: string, args: string[], expected: 'success' | 'error' | 'kill' = 'success', input?: string) => {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...(input === undefined ? {} : { input }) });
    if (input !== undefined) writeFileSync(join(path, name + '.stdin.txt'), input);
    writeFileSync(join(path, name + '.stdout.jsonl'), result.stdout ?? ''); writeFileSync(join(path, name + '.stderr.txt'), result.stderr ?? '');
    commands.push({ command: [process.execPath, ...args], exitCode: result.status, signal: result.signal, stdout: name + '.stdout.jsonl', stderr: name + '.stderr.txt', ...(input === undefined ? {} : { stdin: name + '.stdin.txt' }) });
    assert.equal(result.error, undefined);
    if (expected === 'success') assert.equal(result.status, 0, result.stderr);
    else assert.ok(result.signal === 'SIGKILL' || result.status !== 0);
    if (expected === 'kill') assert.doesNotMatch(result.stderr, /Error:|ERR_/);
    return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  const cli = (name: string, command: string, args: string[] = [], expected: 'success' | 'error' = 'success', input?: string) =>
    run(name, ['apps/cli/src/main.ts', command, '--sandbox', sandbox.root, ...args], expected, input);
  try {
    const setup = scenario.startsWith('historian-') ? 'historian' : ['projection-memory','proposal-metadata-corruption','typed-head-corruption','batch-manifest-corruption','info-outbox-corruption','capture-metadata-corruption','feedback-metadata-corruption'].includes(scenario) ? 'memory'
      : ['projection-source','source-metadata-corruption'].includes(scenario) ? 'handoff' : scenario;
    let infoBatches: string[] | undefined, laterInfo: string | undefined, handoff: unknown, intent: unknown;
    let feedback: { recordId: string; feedbackId: string; input: unknown } | undefined, captureJobId: string | undefined;
    if (scenario.startsWith('owner-info')) {
      infoBatches = cli('setup','remember',[],'success','记住偏好：包管理器使用 pnpm\n记住决定：本项目使用 SQLite WAL\nstop\n')
        .filter(e => e.event === 'remember-result' && e.status === 'activated').map(e => e.batchId);
      assert.equal(infoBatches.length,2);
      assert.equal(cli('first-read','info',['--batch',infoBatches[0]!]).find(e => e.event === 'info-read').read,'read');
    } else if (scenario === 'handoff-versions') handoff = run('setup',['apps/cli/test/support/backup-handoff-worker.ts',sandbox.root,'seed'])[0];
    else if (['memory','handoff','historian'].includes(setup)) {
      const seeded = cli('setup', setup, ['--scenario','synthetic']);
      if (scenario === 'feedback-metadata-corruption') {
        const recordId = seeded.find(event => event.event === 'memory-result').activated.record.recordId;
        feedback = run('feedback-seeded',['apps/cli/test/support/backup-worker.ts',sandbox.root,'seed-feedback',recordId])[0];
      }
    } else cli('setup', 'run');
    if (scenario === 'intent-metadata-corruption') intent = run('intent-before',['apps/cli/test/support/backup-worker.ts',sandbox.root,'read-intent'])[0];
    let unknown: Record<string, string> | undefined;
    if (scenario === 'unknown-before') unknown = run('unknown-before', ['apps/cli/test/support/backup-worker.ts',sandbox.root,'unknown'])[0];
    if (['ENOSPC','EROFS'].includes(scenario)) {
      const original = hash(readFileSync(join(sandbox.root, 'session.jsonl')));
      assert.equal(run('backup-failure', ['apps/cli/test/support/backup-worker.ts',sandbox.root,'backup-failure',scenario])[0].reason, scenario);
      assert.equal(hash(readFileSync(join(sandbox.root, 'session.jsonl'))), original);
      assert.deepEqual(cli('failed-backups', 'backups').find(e => e.event === 'backups').snapshots, []);
    }
    if (scenario === 'backup-directory-crash') {
      assert.equal(run('backup-interrupted',['apps/cli/test/support/backup-worker.ts',sandbox.root,'backup-crash'],'kill')[0].point,'backup-directory');
      const db = new DatabaseSync(join(sandbox.root,'probe.sqlite'),{readOnly:true});
      let id: string;
      try {
        const row = db.prepare("SELECT snapshot_id,dev,ino FROM store_snapshots WHERE state='staging'").get()!;
        assert.ok(row); assert.equal(row.dev,null); assert.equal(row.ino,null); id = String(row.snapshot_id);
      } finally { db.close(); }
      cpSync(sandbox.root,join(path,'interrupted-sandbox'),{recursive:true});
      const manifest = run('backup-discarded',['apps/cli/test/support/backup-worker.ts',sandbox.root,'discard-snapshot',id])[0];
      assert.equal(existsSync(manifest.directory.path),false);
    }
    if (scenario.startsWith('projection-')) {
      const lane = scenario.slice('projection-'.length);
      run('indexed', ['apps/cli/test/support/backup-worker.ts',sandbox.root,'repair-projection',lane]);
      const canonical = (db: DatabaseSync) => hash(JSON.stringify(['request_events','memory_events','source_units','evolution_proposals']
        .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
      const damaged = new DatabaseSync(join(sandbox.root, 'probe.sqlite'));
      let before: string;
      try {
        before = canonical(damaged); damaged.function('euler_store_writer', () => 1); damaged.exec('PRAGMA ignore_check_constraints=ON');
        assert.ok(Number(damaged.prepare('UPDATE search_documents SET projection_generation=0').run().changes) > 0);
      } finally { damaged.close(); }
      cpSync(sandbox.root, join(path, 'damaged-sandbox'), { recursive: true });
      assert.equal(cli('rejected-backup','backup',[],'error').find(e => e.event === 'error').reason,'projection-integrity-failed');
      assert.equal(run('canonical-append',['apps/cli/test/support/backup-worker.ts',sandbox.root,'append-canonical'])[0].health,'healthy');
      assert.equal(run('projection-repaired',['apps/cli/test/support/backup-worker.ts',sandbox.root,'repair-projection',lane])[0].health,'healthy');
      const repaired = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
      try {
        assert.equal(canonical(repaired),before); assert.equal(repaired.prepare('PRAGMA quick_check').get()!.quick_check,'ok');
        assert.equal(repaired.prepare('SELECT count(*) AS n FROM search_documents WHERE projection_generation<1').get()!.n,0);
      } finally { repaired.close(); }
    }
    let cleaned: { operationId: string; path: string } | undefined;
    if (scenario === 'recovery-cleanup-state') {
      const initial = cli('initial-backup','backup').find(e => e.event === 'backup-result').snapshot;
      const first = cli('initial-recovery','restore-snapshot',['--snapshot',initial.id]).find(e => e.event === 'snapshot-restored');
      cleaned = { operationId: first.receipt.operationId, path: first.original.path };
    }
    const createOutput = () => {
      outputRoot = realpathSync.native(mkdtempSync(join(tmpdir(),'euler-t20-output-')));
      return run('project-output',['apps/cli/test/support/backup-file-worker.ts',sandbox.root,outputRoot])[0].controlledFiles[0];
    };
    let expectedOutput: unknown;
    if (scenario === 'project-output-before') expectedOutput = createOutput();
    const saved = scenario.startsWith('migration-') || cleaned
      ? run('backup', ['apps/cli/test/support/backup-worker.ts',sandbox.root,'migration-checkpoint'])[0].snapshot
      : cli('backup', 'backup').find(e => e.event === 'backup-result').snapshot;
    assert.ok(saved?.id);
    const snapshotPath = join(saved.directory.path, 'store.sqlite');
    assert.equal(hash(readFileSync(snapshotPath)), saved.database.hash);
    const snapshotDb = new DatabaseSync(snapshotPath, { readOnly: true });
    let attempts: Record<string, unknown>[], streams: Record<string, unknown>[], snapshotEpoch: number;
    try {
      assert.equal(snapshotDb.prepare('PRAGMA user_version').get()!.user_version, 23);
      assert.equal(snapshotDb.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
      assert.deepEqual(snapshotDb.prepare('PRAGMA foreign_key_check').all(), []);
      attempts = snapshotDb.prepare('SELECT * FROM request_attempts ORDER BY attempt_id').all();
      streams = snapshotDb.prepare('SELECT owner_kind,owner_id FROM execution_streams').all();
      snapshotEpoch = Number(snapshotDb.prepare('SELECT epoch FROM owner_fences').get()!.epoch);
      for (const event of snapshotDb.prepare('SELECT payload,hash FROM request_events').all()) assert.equal(hash(String(event.payload)), event.hash);
    } finally { snapshotDb.close(); }
    if (infoBatches) {
      cli('second-read','info',['--batch',infoBatches[1]!]);
      laterInfo = cli('later-info','remember',[],'success','记住偏好：测试使用独立目录\nstop\n')
        .find(e => e.event === 'remember-result' && e.status === 'activated').batchId;
      assert.ok(laterInfo);
    }
    if (cleaned) {
      run('original-discarded',['apps/cli/test/support/backup-worker.ts',sandbox.root,'discard-recovery',cleaned.operationId]);
      assert.equal(existsSync(cleaned.path),false);
    }
    if (scenario === 'unknown-after') unknown = run('unknown-after', ['apps/cli/test/support/backup-worker.ts',sandbox.root,'unknown'])[0];
    if (scenario === 'project-output-after') expectedOutput = createOutput();
    if (scenario.startsWith('migration-')) {
      const candidate = join(path, 'migration.sqlite'); copyFileSync(snapshotPath, candidate);
      const point = scenario.slice('migration-'.length);
      run('migration', ['apps/cli/test/support/backup-migration-worker.ts',candidate,point], point === 'success' ? 'success' : 'kill');
      const candidateDb = new DatabaseSync(candidate);
      try {
        const version = point === 'before-commit' ? 23 : 24;
        assert.equal(candidateDb.prepare('PRAGMA user_version').get()!.user_version,version);
        const metadata = candidateDb.prepare('SELECT schema_version,ddl_hash FROM schema_meta').get()!;
        assert.equal(metadata.schema_version,version);
        assert.ok(String(candidateDb.prepare("SELECT sql FROM sqlite_schema WHERE name='schema_meta'").get()!.sql).includes(`CHECK(schema_version=${version})`));
        if (version === 24) assert.equal(metadata.ddl_hash,hash(JSON.stringify(candidateDb.prepare('SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name').all())));
        assert.equal(candidateDb.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
        assert.deepEqual(candidateDb.prepare('PRAGMA foreign_key_check').all(), []);
      } finally { candidateDb.close(); }
      assert.equal(hash(readFileSync(snapshotPath)), saved.database.hash);
    }
    if (scenario === 'canonical-corruption') {
      const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'));
      try { db.exec("DROP TRIGGER immutable_request_events_update; UPDATE request_events SET hash='broken' WHERE seq=1"); } finally { db.close(); }
      assert.equal(cli('rejected-backup','backup',[],'error').find(e => e.event === 'error').reason, 'ledger-evidence-gap');
      assert.equal(cli('blocked-run','run',[],'error').find(e => e.event === 'error').reason, 'store-integrity-failed');
    }
    if (['intent-metadata-corruption','info-outbox-corruption','capture-metadata-corruption','feedback-metadata-corruption'].includes(scenario)) {
      const damaged = new DatabaseSync(join(sandbox.root,'probe.sqlite'));
      let reason: string;
      try {
        if (scenario === 'intent-metadata-corruption') {
          damaged.exec('DROP TRIGGER immutable_intent_update');
          assert.equal(damaged.prepare("UPDATE intent_events SET status='paused' WHERE event_id IN (SELECT event_id FROM intent_heads)").run().changes,1);
          reason = 'intent-evidence-gap';
        } else if (scenario === 'info-outbox-corruption') {
          damaged.exec('DROP TRIGGER immutable_projection_jobs_update');
          assert.ok(Number(damaged.prepare("UPDATE projection_jobs SET payload_hash='broken' WHERE kind='host-info'").run().changes)>0);
          reason = 'outbox-evidence-gap';
        } else if (scenario === 'capture-metadata-corruption') {
          captureJobId = String(damaged.prepare('SELECT job_id FROM capture_jobs LIMIT 1').get()!.job_id);
          damaged.exec('DROP TRIGGER immutable_capture_jobs_update');
          damaged.prepare("UPDATE capture_jobs SET payload_hash='broken' WHERE job_id=?").run(captureJobId);
          reason = 'capture-evidence-gap';
        } else {
          damaged.exec('DROP TRIGGER immutable_feedback_events_update');
          assert.equal(damaged.prepare("UPDATE feedback_events SET payload_hash='broken' WHERE feedback_id=?").run(feedback!.feedbackId).changes,1);
          reason = 'feedback-evidence-gap';
        }
      } finally { damaged.close(); }
      cpSync(sandbox.root,join(path,'damaged-sandbox'),{recursive:true});
      assert.equal(cli('rejected-backup','backup',[],'error').find(e => e.event === 'error').reason,reason);
    }
    if (scenario === 'owner-info-metadata-corruption') {
      const damaged = new DatabaseSync(join(sandbox.root,'probe.sqlite'));
      try {
        damaged.function('euler_store_writer',()=>1); damaged.exec('DROP TRIGGER guarded_host_info_update');
        assert.equal(damaged.prepare('UPDATE host_info_batches SET member_count=member_count+1 WHERE batch_id=?').run(infoBatches![0]!).changes,1);
      } finally { damaged.close(); }
      cpSync(sandbox.root,join(path,'damaged-sandbox'),{recursive:true});
      assert.equal(cli('rejected-backup','backup',[],'error').find(e => e.event === 'error').reason,'host-info-evidence-gap');
    }
    if (scenario === 'typed-head-corruption') {
      const damaged = new DatabaseSync(join(sandbox.root,'probe.sqlite'));
      try {
        damaged.function('euler_store_writer',()=>1);
        assert.ok(Number(damaged.prepare("UPDATE memory_heads SET lifecycle='tombstoned' WHERE lifecycle='active'").run().changes)>0);
        assert.equal(damaged.prepare('PRAGMA quick_check').get()!.quick_check,'ok');
        assert.deepEqual(damaged.prepare('PRAGMA foreign_key_check').all(),[]);
      } finally { damaged.close(); }
      cpSync(sandbox.root,join(path,'damaged-sandbox'),{recursive:true});
      assert.equal(cli('rejected-backup','backup',[],'error').find(e => e.event === 'error').reason,'memory-evidence-gap');
      assert.equal(cli('blocked-run','run',[],'error').find(e => e.event === 'error').reason,'store-integrity-failed');
    }
    if (scenario === 'batch-manifest-corruption') {
      const damaged = new DatabaseSync(join(sandbox.root,'probe.sqlite'));
      try {
        damaged.exec('DROP TRIGGER immutable_activation_batches_update');
        assert.ok(Number(damaged.prepare("UPDATE activation_batches SET payload_hash='broken'").run().changes)>0);
      } finally { damaged.close(); }
      cpSync(sandbox.root,join(path,'damaged-sandbox'),{recursive:true});
      assert.equal(cli('rejected-backup','backup',[],'error').find(e => e.event === 'error').reason,'batch-evidence-gap');
    }
    if (scenario === 'source-metadata-corruption' || scenario === 'proposal-metadata-corruption') {
      const table = scenario === 'source-metadata-corruption' ? 'source_units' : 'evolution_proposals';
      const damaged = new DatabaseSync(join(sandbox.root,'probe.sqlite'));
      try {
        damaged.exec('DROP TRIGGER immutable_' + table + '_update');
        assert.ok(Number(damaged.prepare("UPDATE " + table + " SET payload_hash='broken'").run().changes)>0);
      } finally { damaged.close(); }
      cpSync(sandbox.root,join(path,'damaged-sandbox'),{recursive:true});
      assert.match(cli('rejected-backup','backup',[],'error').find(e => e.event === 'error').reason,/source-evidence-gap|proposal-evidence-gap/);
    }
    if (scenario.startsWith('historian-') && scenario.endsWith('-corruption')) {
      const damaged = new DatabaseSync(join(sandbox.root, 'probe.sqlite'));
      try {
        if (scenario === 'historian-publication-corruption') damaged.exec("DROP TRIGGER immutable_compartments_update; UPDATE compartments SET hash='broken'");
        else if (scenario === 'historian-stage-corruption') {
          damaged.function('euler_store_writer',()=>1);
          damaged.exec("UPDATE capture_work SET stage='pending' WHERE job_id IN (SELECT job_id FROM compartments)");
        } else {
          damaged.exec('DROP TRIGGER immutable_capture_jobs_update');
          const row = damaged.prepare('SELECT j.job_id,j.payload FROM capture_jobs j JOIN compartments c ON c.job_id=j.job_id').get()!;
          const payload = JSON.stringify({ ...JSON.parse(String(row.payload)),rawHash:'broken' });
          damaged.prepare('UPDATE capture_jobs SET payload=?,payload_hash=? WHERE job_id=?').run(payload,hash(payload),row.job_id!);
        }
      } finally { damaged.close(); }
      cpSync(sandbox.root, join(path,'damaged-sandbox'), { recursive: true });
      assert.match(cli('rejected-backup','backup',[],'error').find(e => e.event === 'error').reason,/compartment-integrity|historian-source-gap/);
    }
    let operationId: string | undefined;
    if (scenario.startsWith('crash-') || scenario.startsWith('restore-') || scenario === 'discard-preparation') {
      const capacity = scenario.startsWith('restore-');
      const point = scenario === 'discard-preparation' ? 'preparation' : scenario.slice(scenario.indexOf('-') + 1);
      const originalHash = hash(readFileSync(join(sandbox.root,'session.jsonl')));
      assert.equal(run('interrupted', ['apps/cli/test/support/backup-worker.ts',sandbox.root,capacity?'restore-failure':'restore-crash',point], capacity?'success':'kill')[0].point, point);
      const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
      try {
        const pending = db.prepare("SELECT operation_id,state FROM store_restores WHERE state IN ('preparing','prepared')").get()!;
        operationId = String(pending.operation_id);
        assert.notEqual(db.prepare('SELECT state FROM owner_fences').get()!.state, 'open');
        if (['directory','preparation','ENOSPC','EROFS'].includes(point)) {
          assert.equal(pending.state,'preparing'); assert.equal(hash(readFileSync(join(sandbox.root,'session.jsonl'))),originalHash);
        }
      } finally { db.close(); }
      cpSync(sandbox.root, join(path, 'interrupted-sandbox'), { recursive: true });
      if (scenario === 'discard-preparation') {
        const manifest = run('preparation-discarded',['apps/cli/test/support/backup-worker.ts',sandbox.root,'discard-recovery',operationId!])[0];
        assert.equal(existsSync(manifest.directory.path),false); operationId = undefined;
      }
    }
    const restored = cli('restored','restore-snapshot',['--snapshot',saved.id]).find(e => e.event === 'snapshot-restored');
    assert.equal(restored.receipt.schema, 'store/recovered-from-snapshot@v1');
    if (operationId) assert.equal(restored.receipt.operationId, operationId);
    for (const file of saved.files) {
      const bytes = readFileSync(file.source.path); assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.hash);
    }
    const db = new DatabaseSync(join(sandbox.root, 'probe.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.deepEqual(db.prepare('SELECT * FROM request_attempts ORDER BY attempt_id').all(), attempts);
      assert.ok(Number(db.prepare('SELECT epoch FROM owner_fences').get()!.epoch) > snapshotEpoch);
      for (const stream of streams) assert.ok(db.prepare('SELECT 1 FROM store_recovered_owners WHERE kind=? AND owner_id=?').get(String(stream.owner_kind),String(stream.owner_id)));
      const receipt = db.prepare('SELECT receipt,digest FROM store_recovery_events WHERE operation_id=?').get(restored.receipt.operationId)!;
      assert.equal(hash(String(receipt.receipt)), receipt.digest); assert.deepEqual(JSON.parse(String(receipt.receipt)), restored.receipt);
      assert.deepEqual(Object.keys(restored.receipt).sort(), ['createdAt','operationId','outcome','schema']);
      const pending = db.prepare('SELECT state,payload,digest FROM store_restores WHERE operation_id=?').get(restored.receipt.operationId)!;
      assert.equal(pending.state, 'complete'); assert.equal(hash(String(pending.payload)), pending.digest);
      const plan = JSON.parse(String(pending.payload));
      for (const file of plan.originals) assert.equal(hash(readFileSync(join(plan.original.path, file.name))), file.hash);
      if (cleaned) {
        assert.equal(db.prepare('SELECT original_deleted FROM store_restores WHERE operation_id=?').get(cleaned.operationId)!.original_deleted,1);
        assert.equal(existsSync(cleaned.path),false);
      }
      for (const published of db.prepare('SELECT c.*,j.payload,w.run_id,w.stage FROM compartments c JOIN capture_jobs j USING(job_id) JOIN capture_work w USING(job_id)').all()) {
        const source = JSON.parse(String(published.source_json)), attemptId = String(published.attempt_id), job = JSON.parse(String(published.payload));
        assert.equal(published.hash,hash(JSON.stringify({ source,attemptId }))); assert.equal(published.stage,'complete');
        assert.equal(job.rawHash,hash(JSON.stringify(job.range)));
        assert.ok(attempts.some(attempt => attempt.attempt_id===attemptId && attempt.run_id===published.run_id && attempt.outcome==='received'));
      }
      if (infoBatches) {
        const rows = db.prepare('SELECT batch_id,delivery,read_state FROM host_info_batches ORDER BY batch_id').all();
        assert.equal(rows.length,2);
        for (const [index,id] of infoBatches.entries()) {
          const row = rows.find(row => row.batch_id===id)!;
          assert.deepEqual([row.delivery,row.read_state],['delivered',index===0?'read':'unread']);
          const batch = db.prepare('SELECT payload,payload_hash FROM activation_batches WHERE batch_id=?').get(id)!;
          assert.equal(hash(String(batch.payload)),batch.payload_hash);
          assert.equal(db.prepare('SELECT digest FROM host_info_batches WHERE batch_id=?').get(id)!.digest,batch.payload_hash);
        }
        assert.equal(db.prepare('SELECT 1 FROM activation_batches WHERE batch_id=?').get(laterInfo!),undefined);
        const info = plan.originals.find((file: { role: string }) => file.role==='owner-info');
        assert.ok(readFileSync(join(plan.original.path,info.name),'utf8').includes(laterInfo!));
      }
      if (unknown) {
        assert.ok(db.prepare("SELECT 1 FROM store_recovered_owners WHERE kind='job' AND owner_id=?").get(unknown.jobId!));
        const attempt = db.prepare('SELECT outcome FROM request_attempts WHERE attempt_id=?').get(unknown.attemptId!);
        if (scenario === 'unknown-before') assert.equal(attempt!.outcome, 'unknown-sent'); else assert.equal(attempt, undefined);
        const receiver = plan.originals.find((file: { role: string }) => file.role === 'receiver');
        assert.ok(readFileSync(join(plan.original.path, receiver.name),'utf8').includes(unknown.attemptId!));
      }
    } finally { db.close(); }
    if (handoff) {
      const result = run('handoff-verified',['apps/cli/test/support/backup-handoff-worker.ts',sandbox.root,'verify',JSON.stringify(handoff)])[0];
      assert.deepEqual(result.versions,[1,2]); assert.equal(result.privateReadsRejected,4);
      assert.equal(result.unrelatedProposalRejected,true); assert.equal(result.sends,0);
    }
    if (infoBatches) {
      const listed = cli('restored-info','info').find(e => e.event==='info-list');
      assert.deepEqual([listed.pending,listed.unread],[0,1]);
    }
    if (intent) assert.deepEqual(run('intent-verified',['apps/cli/test/support/backup-worker.ts',sandbox.root,'read-intent'])[0],intent);
    if (captureJobId) assert.equal(run('capture-verified',['apps/cli/test/support/backup-worker.ts',sandbox.root,'read-capture',captureJobId])[0].jobId,captureJobId);
    if (feedback) {
      const result = run('feedback-verified',['apps/cli/test/support/backup-worker.ts',sandbox.root,'read-feedback',feedback.recordId])[0];
      const receipt = result.events.find((event: { feedbackId: string }) => event.feedbackId === feedback!.feedbackId);
      assert.equal(receipt.kind,'user_helpful'); assert.deepEqual(receipt.evidence.source,feedback.input);
    }
    if (scenario === 'info-outbox-corruption') {
      const listed = cli('restored-info','info').find(e => e.event === 'info-list');
      assert.deepEqual([listed.pending,listed.unread],[1,1]);
      const displayed = cli('delivered-info','info',['--batch',listed.rows[0].batchId]);
      assert.equal(displayed.find(e => e.event === 'info-read').read,'read');
      const settled = cli('settled-info','info').find(e => e.event === 'info-list');
      assert.deepEqual([settled.pending,settled.unread],[0,0]);
    }
    if (expectedOutput) {
      assert.deepEqual(cli('maintenance-inventory','maintenance-status').find(e => e.event === 'maintenance-status').controlledFiles,[expectedOutput]);
      assert.equal(readFileSync(join(outputRoot!,'result.md'),'utf8'),'EULER-T20 controlled project output');
    }
    const rejected = cli('old-run-rejected','run',[],'error').find(e => e.event === 'error'); assert.equal(rejected.reason, 'recovered-stream-blocked');
    const fresh = cli('new-session','recovery-new-session').find(e => e.event === 'recovery-new-session'); assert.equal(fresh.receipt.outcome, 'received');
    observations.push({ scenario, passed: true, commands, snapshotId: saved.id, operationId: restored.receipt.operationId, preservedAttempts: attempts.length, snapshotStreams: streams.length, newSessionId: fresh.sessionId });
  } catch (error) {
    failed = true; writeFileSync(join(path,'verification-error.txt'), error instanceof Error ? error.stack ?? error.message : String(error));
    observations.push({ scenario, passed: false, commands });
  } finally {
    assert.ok(basename(sandbox.root).startsWith('euler-t01-'));
    if (outputRoot) { cpSync(outputRoot,join(path,'project-output'),{recursive:true}); rmSync(outputRoot,{recursive:true,force:true}); }
    cpSync(sandbox.root, join(path,'sandbox'), { recursive: true });
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}
const contractTestCommand = ['--test','--test-concurrency=1','--test-reporter=tap',
  'apps/cli/test/backup.test.ts','apps/cli/test/backup-inventory.test.ts','apps/cli/test/backup-recovery.test.ts','apps/cli/test/backup-integrity.test.ts'];
const contractTestResult = spawnSync(process.execPath, contractTestCommand, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
writeFileSync(join(directory,'contract-tests.stdout.tap'),contractTestResult.stdout ?? '');
writeFileSync(join(directory,'contract-tests.stderr.txt'),contractTestResult.stderr ?? '');
const contractTests = { command: [process.execPath,...contractTestCommand], exitCode: contractTestResult.status,
  signal: contractTestResult.signal, error: contractTestResult.error?.message ?? null,
  stdout: 'contract-tests.stdout.tap', stderr: 'contract-tests.stderr.txt' };
if (contractTestResult.status !== 0 || contractTestResult.error) failed = true;
function files(path: string, prefix = ''): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(path,entry.name), prefix + entry.name + '/') : [prefix + entry.name]);
}
const git = (args: string[]) => execFileSync('git',args,{encoding:'utf8'}).trim();
const receipt = { schema: 't20-backup-receipt@1', synthetic: true, startedAt, completedAt: new Date().toISOString(),
  status: failed ? 'fail' : evidenceGaps.length ? 'evidence-gap' : 'pass', fixture: { path: fixturePath, sha256: hash(readFileSync(fixturePath)) },
  implementation: { commit: git(['rev-parse','HEAD']), tree: git(['rev-parse','HEAD^{tree}']), changes: git(['status','--short']) },
  environment: { platform: process.platform, arch: arch(), release: release(), node: process.version },
  authority: ['issue:20','docs/architecture/issues/15-euler-v1-spec.md#i19','docs/architecture/issues/10-choose-storage-projections.md'],
  observations, contractTests, evidenceGaps, files: files(directory).map(path => ({ path, sha256: hash(readFileSync(join(directory,path))) })) };
writeFileSync(join(directory,'receipt.json'),JSON.stringify(receipt,null,2) + '\n');
console.log(JSON.stringify({ directory, status: receipt.status, cases: observations.length, failed: observations.filter(row => row.passed === false).length, unavailable: observations.filter(row => row.passed === null).length }));
if (failed) process.exitCode = 1;

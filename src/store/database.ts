// Ledung's database: one SQLite file in the user data folder.
// Each migration runs once, in order; PRAGMA user_version records how far a database has got.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { userDataDir } from '../platform/paths.ts';

// Daily usage totals (migration 38, issue #362): what a call adds to its day's row, and takes away from it.
const DAILY_COLUMNS = ['at', 'account', 'machine', 'model', 'project', 'role', 'trigger', 'input', 'cache_write', 'cache_read', 'output', 'thinking', 'cost', 'subagent'];
const dailyDay = (r: string) => `date(${r}.at / 1000, 'unixepoch', 'localtime')`;
const dailySubagent = (r: string) => `CASE WHEN ${r}.subagent IS NULL THEN 0 ELSE ${r}.input + ${r}.cache_write + ${r}.cache_read + ${r}.output END`;
const dailyKey = (r: string) =>
  `day = ${dailyDay(r)} AND account = ${r}.account AND machine = ${r}.machine AND model = ${r}.model AND project = ${r}.project AND role = ${r}.role AND trigger = ${r}.trigger`;
const dailyAdd = (r: string) => `
  INSERT INTO usage_daily VALUES (${dailyDay(r)}, ${r}.account, ${r}.machine, ${r}.model, ${r}.project, ${r}.role, ${r}.trigger,
    ${r}.input, ${r}.cache_write, ${r}.cache_read, ${r}.output, COALESCE(${r}.thinking, 0), COALESCE(${r}.cost, 0), 1, ${dailySubagent(r)})
  ON CONFLICT DO UPDATE SET input = input + excluded.input, cache_write = cache_write + excluded.cache_write,
    cache_read = cache_read + excluded.cache_read, output = output + excluded.output, thinking = thinking + excluded.thinking,
    cost = cost + excluded.cost, calls = calls + 1, subagent_tokens = subagent_tokens + excluded.subagent_tokens;`;
const dailyTake = (r: string) => `
  UPDATE usage_daily SET input = input - ${r}.input, cache_write = cache_write - ${r}.cache_write, cache_read = cache_read - ${r}.cache_read,
    output = output - ${r}.output, thinking = thinking - COALESCE(${r}.thinking, 0), cost = cost - COALESCE(${r}.cost, 0), calls = calls - 1,
    subagent_tokens = subagent_tokens - ${dailySubagent(r)}
  WHERE ${dailyKey(r)};
  DELETE FROM usage_daily WHERE ${dailyKey(r)} AND calls <= 0;`;

const MIGRATIONS: string[] = [
  // 1: sessions, messages and permission requests.
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    runner TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    claude_session_id TEXT,
    model TEXT,
    claude_version TEXT,
    cwd TEXT,
    created_at INTEGER NOT NULL,
    ended_at INTEGER,
    end_reason TEXT,
    parent_id TEXT REFERENCES sessions(id)
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX messages_by_session ON messages(session_id, id);
  CREATE TABLE permissions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    at INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    input TEXT NOT NULL,
    title TEXT,
    reason TEXT,
    status TEXT NOT NULL,
    decided_by TEXT,
    decided_at INTEGER,
    message TEXT
  );
  CREATE INDEX permissions_pending ON permissions(status) WHERE status = 'pending';
  `,
  // 2: each session's permission mode.
  `
  ALTER TABLE sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default';
  `,
  // 3: session hosts. Each message from Claude Code carries the host's sequence number, and each
  // session the last one stored, so a reconnecting Ledung asks for exactly what it missed. Permission
  // requests keep Claude Code's request id, so one re-sent after a restart is recognised.
  `
  ALTER TABLE messages ADD COLUMN seq INTEGER;
  ALTER TABLE sessions ADD COLUMN host_seq INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE permissions ADD COLUMN request_id TEXT;
  `,
  // 4: questions a session asks with ask_user (step 2). The id is the number shown ("question #12").
  // addressed_to is 'user' or, from step 3, the id of the manager session the question went to.
  `
  CREATE TABLE questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    asked_at INTEGER NOT NULL,
    question TEXT NOT NULL,
    options TEXT,
    addressed_to TEXT NOT NULL,
    status TEXT NOT NULL,
    answer TEXT,
    answered_at INTEGER,
    answered_by TEXT,
    delivered_at INTEGER,
    withdrawn_reason TEXT
  );
  CREATE INDEX questions_by_status ON questions(status, asked_at);
  CREATE INDEX questions_by_session ON questions(session_id, status);
  `,
  // 5: managers (step 3). A session's role; questions a manager asks about a session's question, and
  // answers forwarded from Simon; and the inbox: messages Ledung delivers to a session once it is free
  // (instructions from its manager, updates for a manager, messages between managers).
  `
  ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'session';
  ALTER TABLE questions ADD COLUMN about_question INTEGER;
  ALTER TABLE questions ADD COLUMN forwarded_from INTEGER;
  CREATE TABLE inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    created_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    text TEXT NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX inbox_waiting ON inbox(session_id) WHERE delivered_at IS NULL;
  `,
  // 6: permissions (step 4). Where a prompt went (the user or a manager), the sensitive rule it
  // matched, its scope, and grants: rules allowed for the rest of a session, and who allowed them.
  `
  ALTER TABLE permissions ADD COLUMN addressed_to TEXT NOT NULL DEFAULT 'user';
  ALTER TABLE permissions ADD COLUMN sensitive TEXT;
  ALTER TABLE permissions ADD COLUMN scope TEXT;
  CREATE TABLE grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    tool_name TEXT NOT NULL,
    rule_content TEXT,
    granted_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX grants_by_session ON grants(session_id);
  `,
  // 7: usage (step 5). One record per model call; every change of the plan's usage limits; where each
  // session stands (branch, context); and small facts Ledung keeps about itself (meta).
  `
  CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    message_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    model TEXT NOT NULL,
    input INTEGER NOT NULL,
    cache_write INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    output INTEGER NOT NULL,
    thinking INTEGER,
    cost REAL,
    project TEXT NOT NULL,
    role TEXT NOT NULL,
    team TEXT,
    subagent TEXT,
    branch TEXT,
    trigger TEXT NOT NULL,
    machine TEXT NOT NULL,
    UNIQUE (session_id, message_id)
  );
  CREATE INDEX usage_by_time ON usage(at);
  CREATE INDEX usage_by_session ON usage(session_id, at);
  CREATE TABLE limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    utilization REAL,
    resets_at INTEGER,
    data TEXT NOT NULL
  );
  CREATE INDEX limits_by_kind ON limits(kind, at);
  ALTER TABLE sessions ADD COLUMN branch TEXT;
  ALTER TABLE sessions ADD COLUMN context_tokens INTEGER;
  ALTER TABLE sessions ADD COLUMN context_window INTEGER;
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // 8: each session's pull request, as last read with the GitHub CLI (step 5c).
  `
  ALTER TABLE sessions ADD COLUMN pr TEXT;
  `,
  // 9: machine resources (step 6): priority, pause and the line for a free place; what each turn used.
  `
  ALTER TABLE sessions ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';
  ALTER TABLE sessions ADD COLUMN priority_note TEXT;
  ALTER TABLE sessions ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN queued_at INTEGER;
  ALTER TABLE sessions ADD COLUMN held TEXT;
  CREATE TABLE turn_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    project TEXT NOT NULL,
    role TEXT NOT NULL,
    model TEXT,
    trigger TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    cpu_seconds REAL NOT NULL,
    peak_cores REAL NOT NULL,
    peak_mem INTEGER NOT NULL,
    samples INTEGER NOT NULL,
    commands TEXT NOT NULL
  );
  CREATE INDEX turn_resources_by_session ON turn_resources(session_id, started_at);
  CREATE INDEX turn_resources_by_project ON turn_resources(project, started_at);
  `,
  // 10: projects in the database, each with its one manager (projects and accounts, P1).
  `
  CREATE TABLE projects (
    name TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    manager_id TEXT,
    created_at INTEGER NOT NULL,
    removed_at INTEGER
  );
  `,
  // 11: Claude accounts (projects and accounts, P3); usage, limits and sessions note their account.
  `
  CREATE TABLE accounts (
    name TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    config_dir TEXT,
    email TEXT,
    organization TEXT,
    plan TEXT,
    seen_at INTEGER,
    created_at INTEGER NOT NULL
  );
  ALTER TABLE usage ADD COLUMN account TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE limits ADD COLUMN account TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE sessions ADD COLUMN account TEXT;
  `,
  // Model per session: the model a manager asked for in start_session, kept for resume.
  `
  ALTER TABLE sessions ADD COLUMN requested_model TEXT;
  `,
  // 13: idle stop: what the last turn's Stop hook said about background work and scheduled wake-ups.
  `
  ALTER TABLE sessions ADD COLUMN idle_facts TEXT;
  `,
  // 14: archived sessions leave the sidebar; nothing about them is deleted.
  `
  ALTER TABLE sessions ADD COLUMN archived_at INTEGER;
  `,
  // 15: clear_session's countdown, which can be cancelled, and the last clear (for the change of watch).
  `
  ALTER TABLE sessions ADD COLUMN clear_due INTEGER;
  ALTER TABLE sessions ADD COLUMN cleared_at INTEGER;
  `,
  // 16: the session profile it started with (#20), kept for resume; null: full, as before profiles.
  `
  ALTER TABLE sessions ADD COLUMN profile TEXT;
  `,
  // 17: a compact under way (docs/steps/clear-and-compact.md), kept so a restart mid-compact loses
  // nothing; and what a usage record is, so a compaction is not mistaken for a model call of a turn.
  `
  ALTER TABLE sessions ADD COLUMN compacting TEXT;
  ALTER TABLE usage ADD COLUMN kind TEXT NOT NULL DEFAULT 'call';
  `,
  // 18: away mode's decisions on managers' sensitive calls, for the morning report (issue #35).
  `
  CREATE TABLE away_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    command TEXT NOT NULL,
    pr INTEGER,
    repo TEXT,
    floors TEXT NOT NULL,
    allowed INTEGER NOT NULL,
    reason TEXT NOT NULL
  );
  CREATE INDEX away_log_session ON away_log (session_id, at);
  `,
  // 19: a manager's question about one of its sessions' permission requests (issue #51); the user's
  // answer to it decides that request.
  `
  ALTER TABLE questions ADD COLUMN about_request TEXT;
  `,
  // 20: a question's structured fields (issue #59), as JSON: one column, so later fields need no migration.
  `
  ALTER TABLE questions ADD COLUMN details TEXT;
  `,
  // 21: screenshots attached to a question (issue #60), as JSON; judged in the screenshot view.
  `
  ALTER TABLE questions ADD COLUMN shots TEXT;
  `,
  // 22: a project's name colours (issue #83), as JSON; kept apart from its settings so saving those
  // never clears them. Null: no colours.
  `
  ALTER TABLE projects ADD COLUMN colours TEXT;
  `,
  // 23: the message board between managers (docs/steps/message-board.md). Threads and every post seen
  // or sent (history survives a clear; an ignored sender's post keeps only its id, for de-duplication);
  // which project got which post and how (wake, quiet, channel); each project's board setting; logins the
  // user allowed posting to (the first post asks, decision 6); posts waiting for that answer.
  `
  CREATE TABLE board_threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    participants TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE board_posts (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    author TEXT NOT NULL,
    via_ledung INTEGER NOT NULL,
    from_project TEXT,
    recipients TEXT NOT NULL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    direction TEXT NOT NULL,
    status TEXT NOT NULL
  );
  CREATE INDEX board_posts_thread ON board_posts(thread_id, at);
  CREATE INDEX board_posts_sent ON board_posts(direction, from_project, received_at);
  CREATE TABLE board_deliveries (
    post_id TEXT NOT NULL,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    read_at INTEGER,
    PRIMARY KEY (post_id, project)
  );
  CREATE INDEX board_deliveries_project ON board_deliveries(project, kind, at);
  CREATE TABLE board_projects (
    name TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    channels TEXT NOT NULL
  );
  CREATE TABLE board_contacts (
    login TEXT PRIMARY KEY,
    approved_at INTEGER NOT NULL,
    question_id INTEGER
  );
  CREATE TABLE board_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    manager_id TEXT NOT NULL,
    thread_id TEXT,
    title TEXT,
    recipients TEXT NOT NULL,
    text TEXT NOT NULL,
    question_id INTEGER,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // 24: the order projects and sessions were dragged into in the sidebar (issue #88). Null: never
  // dragged, so the order from before (projects as added; sessions new first, ended last).
  `
  ALTER TABLE projects ADD COLUMN position INTEGER;
  ALTER TABLE sessions ADD COLUMN position INTEGER;
  `,
  // 25: the folder a manager started a session in (start_session's cwd, decision of 2026-10-14), kept
  // for resume: Claude Code keeps its transcripts by working folder. Null: the project folder.
  `
  ALTER TABLE sessions ADD COLUMN work_dir TEXT;
  `,
  // 26: the board per project (docs/steps/message-board.md, "Per project"): each project names its board
  // repo and its own allowlist; threads, posts, deliveries and held posts belong to a repo (thread 6 of two
  // repos are two threads), and each repo has its front desk and cursor. Rows from before get board '' and
  // are given the old config block's repo at start (BoardStore.adoptLegacy), which SQL can't know.
  `
  ALTER TABLE board_projects ADD COLUMN repo TEXT;
  ALTER TABLE board_projects ADD COLUMN allow TEXT;
  CREATE TABLE board_boards (
    repo TEXT PRIMARY KEY,
    front_desk TEXT,
    cursor TEXT
  );
  CREATE TABLE board_threads_new (
    board TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    participants TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (board, id)
  );
  INSERT INTO board_threads_new SELECT '', id, title, participants, created_at, updated_at FROM board_threads;
  DROP TABLE board_threads;
  ALTER TABLE board_threads_new RENAME TO board_threads;
  CREATE TABLE board_posts_new (
    board TEXT NOT NULL,
    id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    author TEXT NOT NULL,
    via_ledung INTEGER NOT NULL,
    from_project TEXT,
    recipients TEXT NOT NULL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (board, id)
  );
  INSERT INTO board_posts_new SELECT '', id, thread_id, author, via_ledung, from_project, recipients, text, at, received_at, direction, status FROM board_posts;
  DROP TABLE board_posts;
  ALTER TABLE board_posts_new RENAME TO board_posts;
  CREATE INDEX board_posts_thread ON board_posts(board, thread_id, at);
  CREATE INDEX board_posts_sent ON board_posts(direction, from_project, received_at);
  CREATE TABLE board_deliveries_new (
    board TEXT NOT NULL,
    post_id TEXT NOT NULL,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    read_at INTEGER,
    PRIMARY KEY (board, post_id, project)
  );
  INSERT INTO board_deliveries_new SELECT '', post_id, project, kind, at, read_at FROM board_deliveries;
  DROP TABLE board_deliveries;
  ALTER TABLE board_deliveries_new RENAME TO board_deliveries;
  CREATE INDEX board_deliveries_project ON board_deliveries(project, kind, at);
  ALTER TABLE board_outbox ADD COLUMN board TEXT NOT NULL DEFAULT '';
  `,
  // 27: board attachments (evidence files of a post): where each is in the board repo, its hash, where it
  // is in this Ledung's board cache, why it could not be fetched, and when it was pruned. A held post keeps
  // the files its manager named, read again when it is sent.
  `
  CREATE TABLE IF NOT EXISTS board_attachments (
    board TEXT NOT NULL,
    post_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha TEXT NOT NULL,
    direction TEXT NOT NULL,
    cache_file TEXT,
    error TEXT,
    at INTEGER NOT NULL,
    pruned_at INTEGER,
    PRIMARY KEY (board, post_id, repo_path)
  );
  CREATE INDEX IF NOT EXISTS board_attachments_thread ON board_attachments(board, thread_id);
  ALTER TABLE board_outbox ADD COLUMN attachments TEXT;
  `,
  // 28: paired devices (issue #160, docs/steps/relay.md steps 4 and 5): the only way in through the public
  // name. The device cookie is kept as its SHA-256 only, so a copy of the database signs no one in. A device
  // has at most one passkey (credential id, COSE public key, signature counter), registered once after pairing.
  `
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cookie_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER,
    credential_id TEXT UNIQUE,
    public_key BLOB,
    counter INTEGER NOT NULL DEFAULT 0,
    passkey_at INTEGER
  );
  `,
  // 29: push notifications to paired phones (issue #246, docs/steps/push.md): at most one subscription per device,
  // the push service's endpoint and the browser's two keys. Deleted when the device is revoked or switches it off.
  `
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    device_id TEXT PRIMARY KEY REFERENCES devices(id),
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // The user's word for a manager's Settings action (issue #263): whether an answer was given on this computer
  // (not through the public name), and which word already allowed which action, so each allows it once.
  `
  ALTER TABLE questions ADD COLUMN answered_here INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS words_used (
    session_id TEXT NOT NULL,
    word TEXT NOT NULL,
    action TEXT NOT NULL,
    used_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, word, action)
  );
  `,
  // 31: since when a session has had its status (issue #265), so list_sessions can say "running for 23 min".
  // Null for rows from before: no duration is shown for them until their status next changes.
  `
  ALTER TABLE sessions ADD COLUMN status_since INTEGER;
  `,
  // 32: two kinds of device (issue #241; docs/steps/manager-link.md "Two kinds of device", Martin's decision 6 and
  // question 5 on #245): 'phone' as before, or 'computer', chosen when the pairing code is made on this computer and
  // never changed. A computer stays logged on (logged_on_at) until log out, revoke or 14 days unused; its cookie is
  // renewed daily (cookie_at), and the one it replaced works a minute more, after which a use of it revokes the device.
  // partitioned: paired inside a frame on another computer's page, so a renewed cookie is set the same way.
  `
  ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'phone';
  ALTER TABLE devices ADD COLUMN partitioned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE devices ADD COLUMN logged_on_at INTEGER;
  ALTER TABLE devices ADD COLUMN cookie_at INTEGER;
  ALTER TABLE devices ADD COLUMN old_cookie_hash TEXT;
  ALTER TABLE devices ADD COLUMN old_cookie_until INTEGER;
  `,
  // 33: a device paired through the hivemind link (issue #273, docs/steps/computer-tabs-link.md part 2): the linked
  // computer that asked for its pairing code, shown on its row so such a pairing is visible here. Null: paired here.
  `
  ALTER TABLE devices ADD COLUMN paired_via TEXT;
  `,
  // 34: the Claude Code program a session's process was started with (issue #341), as JSON {kind, path}: the user's
  // installed one or the SDK's copy. Null for rows from before and for container sessions.
  `
  ALTER TABLE sessions ADD COLUMN claude_program TEXT;
  `,
  // 35: login-folder accounts only (issue #342): the account's login folder inside containers, null for the
  // default (~/.ledung-accounts/<name> in the container user's home), and the containers its sessions have run
  // in (JSON [{container, user}]), so removing it signs out there too. Token accounts become folder accounts in
  // code (src/accounts/token-move.ts), since their folder on this computer is a path only the code knows.
  `
  ALTER TABLE accounts ADD COLUMN container_dir TEXT;
  ALTER TABLE accounts ADD COLUMN containers TEXT;
  `,
  // 36: when a session's stored tool results were last shrunk (issue #349, src/store/trim.ts); a session that ends
  // again after that is shrunk again. Null: never.
  `
  ALTER TABLE sessions ADD COLUMN trimmed_at INTEGER;
  `,
  // 37: when Claude Code last reported a limit's figures unchanged (issue #360). A reading is stored only when its
  // figures change, so its own time says when they first appeared; the page shows the reading's age from this one.
  // Null: never confirmed since it was stored.
  `
  ALTER TABLE limits ADD COLUMN seen_at INTEGER;
  `,
  // 38: daily usage totals (issue #362): what the usage page reads instead of every model call, and what shared
  // usage publishes (#363). One row per local day, account, computer, model, project, role and trigger; filled here
  // from the calls so far, then kept up by triggers on every insert, update (a call recorded again with larger
  // figures, a project renamed) and delete of a call, so no writer of the calls can forget it. The day is the
  // computer's local date, as the page's daily chart has always used.
  `
  CREATE TABLE usage_daily (
    day TEXT NOT NULL,
    account TEXT NOT NULL,
    machine TEXT NOT NULL,
    model TEXT NOT NULL,
    project TEXT NOT NULL,
    role TEXT NOT NULL,
    trigger TEXT NOT NULL,
    input INTEGER NOT NULL,
    cache_write INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    output INTEGER NOT NULL,
    thinking INTEGER NOT NULL,
    cost REAL NOT NULL,
    calls INTEGER NOT NULL,
    subagent_tokens INTEGER NOT NULL,
    PRIMARY KEY (day, account, machine, model, project, role, trigger)
  );
  INSERT INTO usage_daily
    SELECT date(at / 1000, 'unixepoch', 'localtime'), account, machine, model, project, role, trigger,
      SUM(input), SUM(cache_write), SUM(cache_read), SUM(output), SUM(COALESCE(thinking, 0)), SUM(COALESCE(cost, 0)), COUNT(*),
      SUM(CASE WHEN subagent IS NULL THEN 0 ELSE input + cache_write + cache_read + output END)
    FROM usage GROUP BY 1, 2, 3, 4, 5, 6, 7;
  -- What the daily totals don't hold, without reading every call: the branch filter's choices and that branch's calls,
  -- and which sessions have a call that passes the filters (measured at 149k calls: 130 ms each without these).
  CREATE INDEX usage_by_branch ON usage(branch, at);
  DROP INDEX usage_by_session;
  CREATE INDEX usage_by_session ON usage(session_id, at, project, role, trigger, account, model, branch);
  CREATE TRIGGER usage_daily_insert AFTER INSERT ON usage BEGIN ${dailyAdd('new')} END;
  CREATE TRIGGER usage_daily_delete AFTER DELETE ON usage BEGIN ${dailyTake('old')} END;
  -- Only when a figure or a key changed: a streamed reply is recorded again many times with the same figures.
  CREATE TRIGGER usage_daily_update AFTER UPDATE ON usage
    WHEN ${DAILY_COLUMNS.map((c) => `old.${c} IS NOT new.${c}`).join(' OR ')}
    BEGIN ${dailyTake('old')} ${dailyAdd('new')} END;
  `,
  // 39: the asker's conversation just before a question, as JSON ConversationLine[] (issue #368): taken when it is
  // asked, so it stays as it was whatever the conversation does later (a clear, a trim). Null: from before.
  `
  ALTER TABLE questions ADD COLUMN earlier TEXT;
  `,
  // 40: the sources a question attached, as JSON AttachedSource[] (issue #369): fetched when it is asked and kept, so a
  // pruned conversation or an edited comment doesn't change what the question pointed at. Null: none.
  `
  ALTER TABLE questions ADD COLUMN sources TEXT;
  `,
];

export function databaseFile(dir = userDataDir()): string {
  return path.join(dir, 'ledung.db');
}

export function openDatabase(file = databaseFile()): DatabaseSync {
  const db = new DatabaseSync(file);
  // A new database gives freed space back bit by bit (issue #349); before the first table is the only time this
  // needs no VACUUM. An older one is switched at a start (compactAtStart, src/store/trim.ts).
  if (db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get() === undefined) db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

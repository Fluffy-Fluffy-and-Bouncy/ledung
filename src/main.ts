// Ledung core entry point: load the config, open the database, start the server and open the page.
// Flags: --no-open (don't open the browser). `remote-secret` prints a new relay secret and its hash, and exits
// (issue #236, src/remote/secret.ts).
//
// Sessions run in session hosts (src/host/). Restarting Ledung leaves them running and the new Ledung
// reconnects; closing Ledung stops them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardConfig, configPath, createDefaultConfig, loadConfig } from './config.ts';
import { ConfigWatcher } from './config-watch.ts';
import { openBrowser } from './platform/open-browser.ts';
import { exercisedLine } from './platform/exercised.ts';
import { lanNames } from './platform/network.ts';
import { iconFiles, launchTarget, Shortcuts } from './platform/shortcuts.ts';
import { appDir, appVersion, chatImagesDir, envSetting, PACKAGED, remoteDir, userDataDir } from './platform/paths.ts';
import { ChatImages } from './sessions/chat-images.ts';
import { loadOrCreateToken } from './server/security.ts';
import { LedungServer } from './server/server.ts';
import { ANTHROPIC_NOTICE } from './server/source.ts';
import { SessionManager } from './sessions/manager.ts';
import { databaseFile, openDatabase } from './store/database.ts';
import { Store } from './store/store.ts';
import { compactAtStart, HistoryTrimmer } from './store/trim.ts';
import { backfillUsage } from './usage/backfill.ts';
import { GitHubBackend } from './board/github.ts';
import { GitHubRepos } from './board/repos.ts';
import { UsageQueries } from './usage/queries.ts';
import { publisherProjects, UsagePublisher } from './usage/publisher.ts';
import { usageMark, usageSlices } from './usage/publish-source.ts';
import { ProjectRemotes } from './usage/project-remotes.ts';
import { DEFAULT_ACCOUNT } from './accounts/store.ts';
import { Updater } from './update/updater.ts';
import { CheckIn } from './update/checkin.ts';
import { RemoteLink, savedRemote } from './remote/link.ts';
import { RelayAdmin } from './remote/admin.ts';
import { connectVia } from './remote/linked.ts';
import { computerList } from './shared/computers.ts';
import { remoteSecretText } from './remote/secret.ts';
import { Secrets } from './secrets/secrets.ts';
import { osGuard, Vault } from './secrets/vault.ts';
import { localSecretsDir } from './secrets/runtime.ts';

/** Exit code that asks the launcher to start Ledung again (see scripts/release.ts, and src/cli.ts for the npm package). */
const RESTART_CODE = 75;

async function main(): Promise<void> {
  // Before the config is read: a computer new to the relay may not have a remote block yet.
  if (process.argv[2] === 'remote-secret') {
    console.log(remoteSecretText());
    return;
  }
  // The npm package has no clone to copy the example in: its first start writes the defaults (#105).
  if (PACKAGED && createDefaultConfig()) console.log(`Wrote a default config to ${configPath()}.`);
  const config = loadConfig();
  // Started at sign-in or from Ledung.app, with the login shell's PATH or, when it didn't answer, launchd's (#464).
  const startPath = envSetting('START_PATH');
  if (startPath) exercisedLine(`EXERCISED #464 started with the ${startPath === 'login' ? "login shell's" : 'fallback'} PATH`);
  // The relay this Ledung is on: the config's "remote" block, else what Join with a code saved (issue #237).
  const remote = config.remote ?? savedRemote(remoteDir());
  // No database yet: the first start, for a release and the npm package alike (issue #332).
  if (!fs.existsSync(databaseFile())) console.log(ANTHROPIC_NOTICE);
  const db = openDatabase();
  // Space freed by shrinking old tool results, given back once with a VACUUM, before anything else uses it (#349).
  compactAtStart(db, { log: (line) => console.log(line) });
  const store = new Store(db);
  // Usage for sessions that ran before it was recorded (once).
  const filledIn = backfillUsage(store);
  if (filledIn) console.log(`Filled in usage for ${filledIn} earlier model call(s).`);

  let server: LedungServer | null = null;
  let link: RemoteLink | null = null;
  let watcher: ConfigWatcher | null = null;
  const manager = new SessionManager(config, store, (event) => server?.broadcast(event));
  // The message boards between managers: each project names its repo (docs/steps/message-board.md, "Per project").
  const pollMs = boardConfig(config).pollSeconds * 1000;
  // Board attachments are kept in the data folder's board cache, never in a project folder.
  manager.attachBoards((repo) => new GitHubBackend({ repo, pollMs }), new GitHubRepos(), path.join(userDataDir(), 'board-cache'));
  // Images sent with the person's messages (issue #128), in the data folder so the history shows them after a restart.
  // Those uploaded a day ago or more that no message names were never sent: they go (the security review of #128).
  const chatImages = new ChatImages(chatImagesDir());
  chatImages.sweep((id) => store.sentImageNames(id), 24 * 60 * 60 * 1000);
  manager.attachChatImages(chatImages);
  // Locked secrets (issue #468), read before any session is reattached, so its output is blanked from the first line.
  const secrets = await Secrets.open(new Vault(path.join(userDataDir(), 'secrets.enc'), osGuard(userDataDir())), (line) => console.log(line));
  manager.attachSecrets(secrets, localSecretsDir(userDataDir()));

  // Reconnect to sessions whose hosts survived the restart, then mark the rest as ended.
  const attached = await manager.attachRunningHosts();
  const leftover = store.markUnfinishedSessionsEnded('Ledung stopped before this session ended. Resume to continue.', attached);
  // Those that were waiting for memory to start never ran: they say so, and their managers get the task back.
  manager.settleWaitersAfterRestart();
  // In the background: a container that doesn't answer never holds up the start.
  void manager.cleanSecretsAtStart(attached).catch((e) => console.log(`Secrets: the clean-up at start failed: ${(e as Error).message}`));
  // Only now: an away period that ran out while Ledung was off tells the managers that are live (issue #328).
  manager.away.begin();
  // A once-order whose run was under way when Ledung stopped: its result went to that Ledung (review of PR #107, finding 4).
  manager.orders.recover();
  // Whether Claude Code is signed in, so a first start says how to sign in before a session fails on it (issue #333).
  void manager.checkSignIns();

  let shuttingDown = false;
  const shutdown = async (restart: boolean) => {
    if (shuttingDown) return;
    shuttingDown = true;
    manager.boards?.stop();
    usagePublisher.stop();
    checkIn.stop();
    watcher?.stop();
    if (restart) {
      console.log('Restarting; sessions keep running and reconnect after the restart...');
      // A running "!" command doesn't survive the restart (issue #212); its block says so.
      await manager.endShells();
      manager.detachAll();
    } else {
      console.log('Stopping sessions...');
      await manager.shutdown();
    }
    link?.stop();
    relayAdmin.stop();
    await server?.close();
    process.exit(restart ? RESTART_CODE : 0);
  };

  // Restarting needs the launcher, which starts Ledung again; without it, Ledung would just exit.
  const canRestart = envSetting('LAUNCHER') === '1';
  const lan = lanNames(config.lan);
  const onRestart = canRestart ? () => void shutdown(true) : undefined;
  // Settings → Relay, for whoever runs a relay (issue #237); its settings and keys stay in the data folder.
  // Publishing usage to a shared repo (issue #363): off until switched on in Settings.
  const remotes = new ProjectRemotes((name) => {
    const p = manager.projectStore.get(name)?.config;
    return p?.runner === 'local' ? p.path : null;
  });
  const usagePublisher = new UsagePublisher({
    meta: { get: (k) => store.getMeta(k), set: (k, v) => store.setMeta(k, v) },
    keyDir: remoteDir(),
    slices: (range) => usageSlices(db, range),
    mark: () => usageMark(db),
    limits: () => store.latestLimits(),
    computer: () => server?.computerName() ?? 'Ledung',
    projects: () => publisherProjects(manager.projectStore.list(), manager.projectStore.removed()),
    remotes: (names) => remotes.remotes(names),
    emailOf: (account) => account === DEFAULT_ACCOUNT ? manager.accountsEvent().defaultIdentity?.email ?? null : manager.accounts.get(account)?.email ?? null,
    linkedKey: () => server?.linkedUsageKey() ?? Promise.resolve(null),
  });
  const relayAdmin = new RelayAdmin({
    dir: userDataDir(), onComputers: (computers) => server?.sendNewComputers(computers),
    // This Ledung's own computer on the relay, so its owner is never capped (issue #161).
    self: () => {
      const remote = link?.settings();
      return remote ? { relay: remote.relay, name: remote.name } : null;
    },
  });
  const updater = new Updater({
    appDir: appDir(), dataDir: userDataDir(), configPath: configPath(), onRestart, npmVersion: PACKAGED ? appVersion() : undefined,
    // The update channel (#461) is this computer's, like its shortcuts.
    meta: { get: (k) => store.getMeta(k), set: (k, v) => store.setMeta(k, v) },
  });
  // The anonymous daily check-in (#220): on by default, announced on the page, only from the npm package.
  const checkIn = new CheckIn({
    meta: { get: (k) => store.getMeta(k), set: (k, v) => store.setMeta(k, v) },
    version: appVersion(), channel: () => updater.channel(), packaged: PACKAGED,
  });
  server = new LedungServer({
    port: config.port, token: loadOrCreateToken(), store, manager,
    onRestart,
    // Stop Ledung in Settings and `ledung stop` (issue #456): the same stop as Ctrl+C in its window.
    onStop: () => void shutdown(false),
    // Made only when asked, in the first-run question or Settings (issue #415).
    shortcuts: new Shortcuts({ launch: launchTarget(), iconDir: userDataDir(), icons: iconFiles(), meta: { get: (k) => store.getMeta(k), set: (k, v) => store.setMeta(k, v) } }),
    updater,
    checkIn,
    lanNames: lan,
    lanBind: config.lan === true ? '0.0.0.0' : config.lan || undefined,
    lanOpen: !config.lanSignIn,
    usage: new UsageQueries(db),
    relayAdmin,
    usagePublisher,
    computers: computerList(config.computers, remote?.publicName, os.hostname()),
    computerSettings: config.computers,
    linkConnect: config.remote?.linkVia ? connectVia(config.remote.linkVia) : undefined,
    // The VAPID keys stay on this computer, next to the relay's (issue #246).
    push: { keyFile: path.join(remoteDir(), 'push-vapid.json') },
  });
  // The config's remote block, or what Join with a code saved (issue #237); its public name is set when it starts.
  link = new RemoteLink({ server, dir: remoteDir(), configured: config.remote, joinAcme: config.relayJoin });
  server.attachRemote(link);

  try {
    await server.listen();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      manager.detachAll();
      throw new Error(`Port ${config.port} is in use. Is Ledung already running? Otherwise set another "port" in ${configPath()}.`);
    }
    throw e;
  }

  manager.startMeasuring();
  checkIn.start();
  // Old sessions' tool results, shrunk in the background in small steps (issue #349).
  const trimmer = new HistoryTrimmer(db, { days: () => manager.currentConfig.keepToolResultsDays, log: (line) => console.log(line) });
  trimmer.start();
  // A changed config file applies its live settings at once (issue #353); a shorter keepToolResultsDays shrinks now.
  watcher = new ConfigWatcher({
    file: configPath(), started: config, log: (line) => console.log(line),
    apply: (next, changed) => {
      manager.applyConfig(next, changed);
      if (changed.includes('keepToolResultsDays')) void trimmer.run().catch((e) => console.log(`Shrinking old tool results failed: ${(e as Error).message}`));
    },
    onStatus: (status) => manager.setConfigStatus(status),
  });
  manager.setConfigStatus(watcher.status());
  watcher.start();
  manager.boards?.start();
  usagePublisher.start();

  // Only once Ledung listens, and in the background: a relay that is down never holds up the start (#160).
  link.start();
  relayAdmin.start();

  const loginUrl = `http://127.0.0.1:${config.port}/login?token=${loadOrCreateToken()}`;
  console.log(`Ledung is running at http://127.0.0.1:${config.port}`);
  console.log(`Config: ${configPath()}`);
  console.log(`Data:   ${userDataDir()}`);
  if (remote) console.log(`Remote: ${remote.publicName}, through the relay at ${new URL(remote.relay).host}${config.remote ? '' : ' (joined in Settings)'}`);
  if (attached.length) console.log(`Reconnected to ${attached.length} running session(s).`);
  const polled = manager.boards?.polled() ?? [];
  if (polled.length) console.log(`Boards: ${polled.join(', ')} (GitHub, polled every ${pollMs / 1000} s)`);
  if (leftover) console.log(`${leftover} session(s) from the last run were marked ended; they can be resumed.`);
  console.log(`Sign-in link (keep it private): ${loginUrl}`);
  if (lan.length && !config.lanSignIn) {
    console.log(`Open to the local network without sign-in: ${lan.map((n) => `http://${n}:${config.port}`).join(', ')}`);
  } else if (lan.length) {
    console.log('Open to the local network. Sign-in links for other computers (open one once in that browser):');
    for (const name of lan) console.log(`  http://${name}:${config.port}/login?token=${loadOrCreateToken()}`);
  }
  if (remote) console.log(`Public name: https://${remote.publicName} (paired devices only; pair one in Settings → Phones)`);
  if (!process.argv.includes('--no-open')) openBrowser(loginUrl);

  // Ctrl+C, and closing the console window (SIGHUP on Windows), close Ledung and stop its sessions.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) process.on(signal, () => void shutdown(false));
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});

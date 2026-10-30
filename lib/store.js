import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, fsyncSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, "..", "data");
const STORE_PATH = join(DATA_DIR, "purge.json");

/**
 * @typedef {{ userId: string|null, channelId: string|null }} JobTarget
 * @typedef {{
 *   mode: string,
 *   targets: JobTarget[],
 *   xCh: string[],
 *   xUsr: string[],
 *   sc: Record<string, string>,
 *   q: string[],
 *   f: string[],
 *   scanDone: boolean,
 *   deletedBulk?: number,
 *   deletedOld?: number,
 *   updatedAt?: string,
 * }} PersistedJob
 */

let cache = /** @type {{ v: number, job: PersistedJob | null }} */ ({ v: 2, job: null });
let writeChain = Promise.resolve();

function ensureDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

function normalizeJob(job) {
  if (!job) return null;
  if (!Array.isArray(job.targets)) {
    job.targets = [];
    if (job.targetChannel || job.targetUser) {
      job.targets.push({
        channelId: job.targetChannel || null,
        userId: job.targetUser || null,
      });
    }
    delete job.targetChannel;
    delete job.targetUser;
  }
  if (!Array.isArray(job.f)) job.f = [...(job.q || [])];
  if (!Array.isArray(job.q)) job.q = [];
  if (!job.sc) job.sc = {};
  return job;
}

export function loadStore() {
  ensureDir();
  if (!existsSync(STORE_PATH)) {
    cache = { v: 2, job: null };
    return cache;
  }
  try {
    cache = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    if (cache.job) cache.job = normalizeJob(cache.job);
    cache.v = 2;
  } catch {
    cache = { v: 2, job: null };
  }
  return cache;
}

function persistSync() {
  ensureDir();
  const tmp = `${STORE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache));
  try {
    const fd = openSync(tmp, "r+");
    fsyncSync(fd);
    closeSync(fd);
  } catch {
    /* best-effort */
  }
  renameSync(tmp, STORE_PATH);
}

export function saveStore() {
  writeChain = writeChain.then(() => persistSync());
  return writeChain;
}

export function persistStoreNow() {
  if (cache.job) cache.job.updatedAt = new Date().toISOString();
  persistSync();
}

export function flushStore() {
  persistStoreNow();
}

export function getJob() {
  return cache.job;
}

function targetKey(t) {
  return `${t.channelId || ""}:${t.userId || ""}`;
}

function addTarget(job, userId, channelId) {
  const t = { userId: userId || null, channelId: channelId || null };
  if (!t.userId && !t.channelId) return;
  const key = targetKey(t);
  if (!job.targets.some((x) => targetKey(x) === key)) {
    job.targets.push(t);
  }
}

/**
 * @param {{ mode: 'all'|'single', targetChannel?: string, targetUser?: string, excludeChannelIds: string[], excludeUserIds: string[] }} opts
 * @param {{ forceRescan?: boolean }} [meta]
 */
export function initJob(opts, meta = {}) {
  const forceRescan = Boolean(meta.forceRescan);
  const mode = opts.mode === "single" ? "single" : "all";
  const xCh = [...new Set(opts.excludeChannelIds.map(String))];
  const xUsr = [...new Set(opts.excludeUserIds.map(String))];
  const newUser = opts.targetUser ? String(opts.targetUser).trim() : null;
  const newChannel = opts.targetChannel ? String(opts.targetChannel).trim() : null;

  if (cache.job) cache.job = normalizeJob(cache.job);

  if (!cache.job || cache.job.mode !== mode) {
    cache.job = {
      mode,
      targets: [],
      xCh,
      xUsr,
      sc: {},
      q: [],
      f: [],
      scanDone: false,
      deletedBulk: cache.job?.deletedBulk || 0,
      deletedOld: cache.job?.deletedOld || 0,
    };
    if (mode === "single") addTarget(cache.job, newUser, newChannel);
    persistStoreNow();
    return saveStore();
  }

  cache.job.xCh = xCh;
  cache.job.xUsr = xUsr;

  if (mode === "single" && (newUser || newChannel)) {
    const before = cache.job.targets.length;
    addTarget(cache.job, newUser, newChannel);
    if (cache.job.targets.length > before) {
      cache.job.scanDone = false;
    }
  }

  if (forceRescan) {
    cache.job.sc = {};
    cache.job.scanDone = false;
  }

  reopenChannelsWithPendingQueue();
  persistStoreNow();
  return saveStore();
}

export function reopenChannelsWithPendingQueue() {
  if (!cache.job) return;
  for (const row of cache.job.q) {
    const channelId = row.split(",")[1];
    if (cache.job.sc[channelId] === "DONE") {
      delete cache.job.sc[channelId];
      cache.job.scanDone = false;
    }
  }
}

export function setChannelCursor(channelId, cursor) {
  if (!cache.job) return saveStore();
  if (cursor == null) delete cache.job.sc[channelId];
  else cache.job.sc[channelId] = cursor;
  persistStoreNow();
  return saveStore();
}

export function markScanDone() {
  if (!cache.job) return saveStore();
  reopenChannelsWithPendingQueue();
  if (cache.job.q.length > 0) {
    cache.job.scanDone = false;
  } else {
    cache.job.scanDone = true;
  }
  persistStoreNow();
  return saveStore();
}

export function saveJobStats(deletedBulk, deletedOld) {
  if (!cache.job) return;
  cache.job.deletedBulk = deletedBulk;
  cache.job.deletedOld = deletedOld;
  persistStoreNow();
}

function rowIds(rows) {
  const seen = new Set();
  for (const row of rows) seen.add(row.split(",")[0]);
  return seen;
}

function appendRows(field, rows) {
  if (!cache.job || !rows.length) return;
  const seen = rowIds(cache.job[field]);
  for (const { messageId, channelId, young } of rows) {
    if (seen.has(messageId)) continue;
    seen.add(messageId);
    const line = `${messageId},${channelId},${young ? 1 : 0}`;
    cache.job[field].push(line);
  }
}

export function appendQueue(rows) {
  if (!cache.job || !rows.length) return saveStore();
  appendRows("q", rows);
  appendRows("f", rows);
  persistStoreNow();
  return saveStore();
}

export function parseQueue() {
  if (!cache.job) return [];
  return cache.job.q.map(parseRow);
}

export function parseFound() {
  if (!cache.job) return [];
  return (cache.job.f || []).map(parseRow);
}

function parseRow(row) {
  const [messageId, channelId, y] = row.split(",");
  return { messageId, channelId, young: y === "1" };
}

export function removeFromQueue(messageIds) {
  if (!cache.job || !messageIds.size) return saveStore();
  cache.job.q = cache.job.q.filter((row) => !messageIds.has(row.split(",")[0]));
  persistStoreNow();
  return saveStore();
}

export function queueStats() {
  const items = parseQueue();
  let bulk = 0;
  let old = 0;
  for (const it of items) {
    if (it.young) bulk += 1;
    else old += 1;
  }
  return { total: items.length, bulk, old };
}

export function foundStats() {
  return (cache.job?.f || []).length;
}

export function getDataPath() {
  return STORE_PATH;
}

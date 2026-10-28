import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, "..", "data");
const STORE_PATH = join(DATA_DIR, "purge.json");

/** @typedef {{ mode: string, targetChannel: string|null, targetUser: string|null, xCh: string[], xUsr: string[], sc: Record<string, string>, q: string[], scanDone: boolean }} PersistedJob */

let cache = /** @type {{ v: number, job: PersistedJob | null }} */ ({ v: 1, job: null });
let writeChain = Promise.resolve();

function ensureDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

export function loadStore() {
  ensureDir();
  if (!existsSync(STORE_PATH)) {
    cache = { v: 1, job: null };
    return cache;
  }
  try {
    cache = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  } catch {
    cache = { v: 1, job: null };
  }
  return cache;
}

function persistSync() {
  ensureDir();
  const tmp = `${STORE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, STORE_PATH);
}

export function saveStore() {
  writeChain = writeChain.then(() => persistSync());
  return writeChain;
}

export function persistStoreNow() {
  persistSync();
}

export function getJob() {
  return cache.job;
}

/**
 * @param {{ mode: 'all'|'single', targetChannel?: string, targetUser?: string, excludeChannelIds: string[], excludeUserIds: string[] }} opts
 */
export function initJob(opts) {
  const next = {
    mode: opts.mode,
    targetChannel: opts.targetChannel || null,
    targetUser: opts.targetUser || null,
    xCh: [...new Set(opts.excludeChannelIds.map(String))],
    xUsr: [...new Set(opts.excludeUserIds.map(String))],
    sc: {},
    q: [],
    scanDone: false,
  };
  if (
    cache.job &&
    cache.job.mode === next.mode &&
    cache.job.targetChannel === next.targetChannel &&
    cache.job.targetUser === next.targetUser
  ) {
    cache.job.xCh = next.xCh;
    cache.job.xUsr = next.xUsr;
    cache.job.sc = {};
    cache.job.scanDone = false;
  } else {
    cache.job = next;
  }
  persistStoreNow();
  return saveStore();
}

export function setChannelCursor(channelId, cursor) {
  if (!cache.job) return saveStore();
  if (cursor == null) delete cache.job.sc[channelId];
  else cache.job.sc[channelId] = cursor;
  return saveStore();
}

export function markScanDone() {
  if (cache.job) cache.job.scanDone = true;
  return saveStore();
}

function queuedIds() {
  const s = new Set();
  if (!cache.job) return s;
  for (const row of cache.job.q) s.add(row.split(",")[0]);
  return s;
}

export function appendQueue(rows) {
  if (!cache.job || !rows.length) return saveStore();
  const seen = queuedIds();
  for (const { messageId, channelId, young } of rows) {
    if (seen.has(messageId)) continue;
    seen.add(messageId);
    cache.job.q.push(`${messageId},${channelId},${young ? 1 : 0}`);
  }
  persistStoreNow();
  return saveStore();
}

export function parseQueue() {
  if (!cache.job) return [];
  return cache.job.q.map((row) => {
    const [messageId, channelId, y] = row.split(",");
    return { messageId, channelId, young: y === "1" };
  });
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

export function getDataPath() {
  return STORE_PATH;
}

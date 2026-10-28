import { ChannelTypes } from "./discord-self.js";

const DM_TYPES = new Set([
  ChannelTypes.DM,
  ChannelTypes.GROUP_DM,
  "DM",
  "GROUP_DM",
  1,
  3,
]);
import {
  appendQueue,
  getJob,
  initJob,
  loadStore,
  markScanDone,
  parseQueue,
  queueStats,
  removeFromQueue,
  saveStore,
  setChannelCursor,
} from "./store.js";

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
const SCAN_PAGE_DELAY_MS = Number(process.env.SCAN_PAGE_DELAY_MS || 6010);
const DELETE_MIN_MS = Number(process.env.DELETE_MIN_MS || 1010);
const DELETE_MAX_MS = Number(process.env.DELETE_MAX_MS || 1250);
const BULK_DELETE_DELAY_MS = Number(process.env.BULK_DELETE_DELAY_MS || 1100);

export const MAX_SERVER_LOGS = 1000;
export const MAX_UI_LOGS = 100;

/** @type {import('discord.js-selfbot-v13').Client | null} */
let clientRef = null;

let state = emptyState();
let cancelRequested = false;
/** @type {Promise<void> | null} */
let activeJob = null;

function emptyState() {
  return {
    running: false,
    phase: "idle",
    mode: null,
    targetChannel: null,
    targetUser: null,
    accountTag: null,
    currentChannel: null,
    channelsTotal: 0,
    channelsDone: 0,
    scanPagesDone: 0,
    foundBulkEligible: 0,
    foundOld: 0,
    deletedBulk: 0,
    deletedOld: 0,
    deleteErrors: 0,
    queuePending: 0,
    etaSeconds: null,
    etaLabel: null,
    excludeChannelIds: [],
    excludeUserIds: [],
    startedAt: null,
    completedAt: null,
    error: null,
    log: [],
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDeleteDelayMs() {
  return DELETE_MIN_MS + Math.random() * (DELETE_MAX_MS - DELETE_MIN_MS);
}

function trimServerLogs(log) {
  if (!Array.isArray(log)) return [];
  return log.length > MAX_SERVER_LOGS ? log.slice(0, MAX_SERVER_LOGS) : log;
}

function pushLog(line) {
  const ts = new Date().toISOString().slice(11, 19);
  state.log.unshift(`[${ts}] ${line}`);
  state.log = trimServerLogs(state.log);
  console.log(line);
}

function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m < 60 ? `${m}m ${s}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function recomputeEta(pagesLeft, bulk, old) {
  const scanSec = pagesLeft * (SCAN_PAGE_DELAY_MS / 1000);
  const bulkSec = Math.ceil(bulk / 100) * (BULK_DELETE_DELAY_MS / 1000);
  const oldSec = old * ((DELETE_MIN_MS + DELETE_MAX_MS) / 2 / 1000);
  state.etaSeconds = Math.ceil(scanSec + bulkSec + oldSec);
  state.etaLabel = formatDuration(state.etaSeconds);
}

function syncCounts() {
  const q = queueStats();
  state.queuePending = q.total;
  state.foundBulkEligible = q.bulk + state.deletedBulk;
  state.foundOld = q.old + state.deletedOld;
}

export function getJobState() {
  syncCounts();
  state.log = trimServerLogs(state.log);
  const out = JSON.parse(JSON.stringify(state));
  out.log = (out.log || []).slice(0, MAX_UI_LOGS);
  return out;
}

export function cancelPurgeJob() {
  if (!state.running) return getJobState();
  cancelRequested = true;
  pushLog("Cancel requested.");
  return getJobState();
}

export function setClient(client) {
  clientRef = client;
}

function parseIdList(raw) {
  if (!raw) return [];
  const parts = Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/);
  return [...new Set(parts.map((s) => String(s).trim()).filter(Boolean))];
}

function isDmChannel(ch) {
  return DM_TYPES.has(ch.type);
}

function isTextPurgeChannel(ch) {
  if (!ch) return false;
  if (isDmChannel(ch)) return true;
  if (typeof ch.isText === "function" && ch.isText()) return true;
  if (typeof ch.isTextBased === "function" && ch.isTextBased() && !ch.isVoiceBased?.()) {
    return true;
  }
  return false;
}

function channelLabel(ch) {
  if (ch.type === ChannelTypes.DM || ch.type === "DM") {
    const r = ch.recipient;
    return r ? `@${r.username}` : "DM";
  }
  return ch.name || "Group DM";
}

function shouldSkipChannel(ch, excludeCh, excludeUsr) {
  if (excludeCh.has(ch.id)) return true;
  if (ch.type === ChannelTypes.DM || ch.type === "DM") {
    const rid = ch.recipientId || ch.recipient?.id;
    if (rid && excludeUsr.has(rid)) return true;
  }
  return false;
}

async function fetchChannel(client, id) {
  const cached = client.channels.cache.get(id);
  if (cached) return cached;
  try {
    const ch = await client.channels.fetch(id, { force: true });
    if (ch?.sync) await ch.sync().catch(() => {});
    return ch;
  } catch (err) {
    const code = err.code ?? err.httpStatus;
    if (code === 10003 || code === 404) {
      throw new Error(
        `Channel ${id} not found. Use a DM channel ID from the picker, or the other person's user ID (not your own).`,
      );
    }
    throw err;
  }
}

async function openDmWithUser(client, userId) {
  const cached = client.channels.cache.find(
    (c) => (c.type === ChannelTypes.DM || c.type === "DM") && c.recipientId === userId,
  );
  if (cached) return cached;
  try {
    const dm = await client.users.createDM(userId);
    if (dm?.sync) await dm.sync().catch(() => {});
    return dm;
  } catch (err) {
    throw new Error(`Could not open DM with user ${userId}: ${err.message}`);
  }
}

async function resolveTargetChannels(job) {
  const client = clientRef;
  if (!client?.user) throw new Error("Client not ready.");

  const excludeCh = new Set(job.xCh);
  const excludeUsr = new Set(job.xUsr);

  if (job.mode === "single") {
    if (job.targetChannel) {
      const ch = await fetchChannel(client, job.targetChannel);
      if (!isTextPurgeChannel(ch)) {
        throw new Error("That channel is not text-based or cannot be purged.");
      }
      if (shouldSkipChannel(ch, excludeCh, excludeUsr)) {
        throw new Error("Target channel is excluded.");
      }
      return [ch];
    }
    if (job.targetUser) {
      if (excludeUsr.has(job.targetUser)) {
        throw new Error("Target user is excluded.");
      }
      if (job.targetUser === client.user.id) {
        throw new Error("Use Saved Messages / a channel ID — not your own user ID.");
      }
      const dm = await openDmWithUser(client, job.targetUser);
      if (excludeCh.has(dm.id)) throw new Error("Target DM channel is excluded.");
      return [dm];
    }
    throw new Error("Single mode requires channelId or userId.");
  }

  const list = [];
  for (const ch of client.channels.cache.values()) {
    if (!isDmChannel(ch)) continue;
    if (shouldSkipChannel(ch, excludeCh, excludeUsr)) continue;
    list.push(ch);
  }
  list.sort((a, b) => channelLabel(a).localeCompare(channelLabel(b)));
  return list;
}

async function scanChannel(ch, myId) {
  const job = getJob();
  if (!job) return;

  const cid = ch.id;
  const cursor = job.sc[cid];
  if (cursor === "DONE") {
    state.channelsDone += 1;
    return;
  }

  state.currentChannel = { id: cid, name: channelLabel(ch) };
  let before = cursor && cursor !== "DONE" ? cursor : undefined;

  while (true) {
    if (cancelRequested) break;

    const batch = await ch.messages.fetch({ limit: 100, before });
    state.scanPagesDone += 1;

    if (batch.size === 0) {
      await setChannelCursor(cid, "DONE");
      break;
    }

    const rows = [];
    for (const msg of batch.values()) {
      if (msg.author?.id !== myId) continue;
      const young = Date.now() - msg.createdTimestamp < TWO_WEEKS_MS;
      rows.push({ messageId: msg.id, channelId: cid, young });
    }
    if (rows.length) await appendQueue(rows);
    syncCounts();

    before = batch.last()?.id;
    await setChannelCursor(cid, before);
    pushLog(`Scan ${channelLabel(ch)}: page ${batch.size} msgs, +${rows.length} yours`);

    if (batch.size < 100) {
      await setChannelCursor(cid, "DONE");
      break;
    }
    await sleep(SCAN_PAGE_DELAY_MS);
  }

  state.channelsDone += 1;
}

async function deleteFromChannel(ch, items) {
  const young = items.filter((i) => i.young);
  const old = items.filter((i) => !i.young);

  let i = 0;
  while (i < young.length) {
    if (cancelRequested) return;
    const chunk = young.slice(i, i + 100);
    const removed = new Set();

    if (chunk.length === 1) {
      try {
        await ch.messages.delete(chunk[0].messageId);
        state.deletedBulk += 1;
        removed.add(chunk[0].messageId);
      } catch (err) {
        state.deleteErrors += 1;
        pushLog(`Delete failed: ${err.message}`);
      }
      await sleep(randomDeleteDelayMs());
      i += 1;
    } else {
      try {
        await ch.bulkDelete(
          chunk.map((c) => c.messageId),
          false,
        );
        state.deletedBulk += chunk.length;
        for (const c of chunk) removed.add(c.messageId);
        pushLog(`Bulk deleted ${chunk.length} (≤14d) in ${channelLabel(ch)}`);
      } catch (err) {
        pushLog(`Bulk not allowed (${err.message}) — one-by-one`);
        for (const c of chunk) {
          if (cancelRequested) return;
          try {
            await ch.messages.delete(c.messageId);
            state.deletedBulk += 1;
            removed.add(c.messageId);
          } catch (e) {
            state.deleteErrors += 1;
          }
          await sleep(randomDeleteDelayMs());
        }
      }
      i += chunk.length;
      await sleep(BULK_DELETE_DELAY_MS);
    }
    if (removed.size) await removeFromQueue(removed);
    syncCounts();
  }

  for (const it of old) {
    if (cancelRequested) return;
    if (!parseQueue().some((q) => q.messageId === it.messageId)) continue;
    try {
      await ch.messages.delete(it.messageId);
      state.deletedOld += 1;
      await removeFromQueue(new Set([it.messageId]));
    } catch (err) {
      state.deleteErrors += 1;
      pushLog(`Old delete: ${err.message}`);
    }
    syncCounts();
    await sleep(randomDeleteDelayMs());
  }
}

async function runDeletePhase() {
  state.phase = "deleting";
  const byChannel = new Map();
  for (const it of parseQueue()) {
    if (!byChannel.has(it.channelId)) byChannel.set(it.channelId, []);
    byChannel.get(it.channelId).push(it);
  }

  for (const [channelId, items] of byChannel) {
    if (cancelRequested) break;
    const ch = await clientRef.channels.fetch(channelId);
    state.currentChannel = { id: channelId, name: channelLabel(ch) };
    pushLog(`Deleting ${items.length} in ${channelLabel(ch)}`);
    await deleteFromChannel(ch, items);
    const q = queueStats();
    recomputeEta(0, q.bulk, q.old);
  }
}

async function runPurge() {
  const job = getJob();
  if (!job) {
    state.phase = "error";
    state.error = "No persisted job.";
    activeJob = null;
    return;
  }

  const client = clientRef;
  if (!client?.user) {
    state.phase = "error";
    state.error = "Client not ready.";
    activeJob = null;
    return;
  }

  cancelRequested = false;
  state.running = true;
  state.mode = job.mode;
  state.targetChannel = job.targetChannel;
  state.targetUser = job.targetUser;
  state.excludeChannelIds = [...job.xCh];
  state.excludeUserIds = [...job.xUsr];
  state.accountTag = client.user.tag;
  if (!state.startedAt) state.startedAt = new Date().toISOString();

  try {
    const channels = await resolveTargetChannels(job);
    state.channelsTotal = channels.length;
    pushLog(
      `Purge ${job.mode === "single" ? "single target" : "all DMs"} — ${channels.length} channel(s)`,
    );

    if (!job.scanDone) {
      state.phase = "scanning";
      for (const ch of channels) {
        if (cancelRequested) break;
        await scanChannel(ch, client.user.id);
        recomputeEta(
          (channels.length - state.channelsDone) * 2,
          queueStats().bulk,
          queueStats().old,
        );
      }
      await markScanDone();
    }

    if (!cancelRequested) {
      await runDeletePhase();
    }

    if (cancelRequested) {
      state.phase = "cancelled";
    } else if (queueStats().total === 0) {
      state.phase = "done";
      state.etaSeconds = 0;
      state.etaLabel = "0s";
      pushLog(`Finished. Removed ${state.deletedBulk} recent + ${state.deletedOld} older.`);
    } else {
      state.phase = "paused";
      pushLog(`Paused with ${queueStats().total} still queued (resumes on restart).`);
    }
  } catch (err) {
    state.phase = "error";
    state.error = err.message;
    pushLog(`Fatal: ${err.message}`);
  } finally {
    state.running = false;
    state.completedAt = new Date().toISOString();
    state.currentChannel = null;
    activeJob = null;
    await saveStore();
  }
}

export function startPurgeJob(options) {
  if (activeJob) throw new Error("A job is already running.");

  const mode = options.mode === "single" ? "single" : "all";
  const excludeChannelIds = parseIdList(options.excludeChannelIds);
  const excludeUserIds = parseIdList(options.excludeUserIds);
  const targetChannel = options.channelId ? String(options.channelId).trim() : null;
  const targetUser = options.userId ? String(options.userId).trim() : null;

  if (mode === "single" && !targetChannel && !targetUser) {
    throw new Error("Single mode needs channelId or userId.");
  }

  loadStore();
  initJob({
    mode,
    targetChannel,
    targetUser,
    excludeChannelIds,
    excludeUserIds,
  });

  state = emptyState();
  state.running = true;
  state.phase = "scanning";
  state.mode = mode;
  state.targetChannel = targetChannel;
  state.targetUser = targetUser;
  state.excludeChannelIds = excludeChannelIds;
  state.excludeUserIds = excludeUserIds;
  state.startedAt = new Date().toISOString();

  activeJob = runPurge().catch((err) => {
    console.error(err);
    state.running = false;
    state.phase = "error";
    state.error = err.message;
    activeJob = null;
  });

  return getJobState();
}

export async function resumePersistedJobIfAny() {
  loadStore();
  const job = getJob();
  if (!job) return;
  const q = queueStats();
  if (job.scanDone && q.total === 0) return;
  if (activeJob) return;
  if (!clientRef?.user) return;

  console.log("Auto-resuming DM purge…");
  state = emptyState();
  state.running = true;
  activeJob = runPurge();
  await activeJob;
}

export async function listDmChannels() {
  const client = clientRef;
  if (!client?.user) return [];
  const out = [];
  for (const ch of client.channels.cache.values()) {
    if (!isDmChannel(ch)) continue;
    out.push({
      id: ch.id,
      type: ch.type === ChannelTypes.GROUP_DM || ch.type === "GROUP_DM" ? "group" : "dm",
      name: channelLabel(ch),
      recipientId: ch.recipientId || ch.recipient?.id || null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

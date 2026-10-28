import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "discord.js-selfbot-v13";
import {
  cancelPurgeJob,
  getJobState,
  startPurgeJob,
  resumePersistedJobIfAny,
  setClient,
  listDmChannels,
} from "./lib/purge.js";
import { loadStore, getDataPath } from "./lib/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.TOKEN;

if (!TOKEN) {
  console.error("Set TOKEN (user account token) in the environment.");
  process.exit(1);
}

loadStore();

const client = new Client({ checkUpdate: false });
setClient(client);

const html = readFileSync(join(__dirname, "public", "index.html"), "utf8");

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, { ...getJobState(), storePath: getDataPath() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/dms") {
      if (!client.user) {
        sendJson(res, 503, { error: "Not logged in yet.", channels: [] });
        return;
      }
      sendJson(res, 200, {
        account: { id: client.user.id, tag: client.user.tag },
        channels: await listDmChannels(),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/purge") {
      const body = await readJsonBody(req);
      if (body === null) {
        sendJson(res, 400, { error: "Invalid JSON." });
        return;
      }
      if (!client.user) {
        sendJson(res, 503, { error: "Not logged in yet." });
        return;
      }
      try {
        sendJson(res, 200, startPurgeJob(body));
      } catch (err) {
        sendJson(res, 409, { error: err.message });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/cancel") {
      sendJson(res, 200, cancelPurgeJob());
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, ready: Boolean(client.user) });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
}).listen(PORT, () => {
  console.log(`DM purge UI on port ${PORT}`);
  console.log(`Store: ${getDataPath()}`);
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  resumePersistedJobIfAny().catch((e) => console.error(e.message));
});

client.login(TOKEN).catch((err) => {
  console.error("Login failed:", err.message);
  process.exit(1);
});

process.on("SIGTERM", () => {
  client.destroy();
  process.exit(0);
});

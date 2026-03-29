// This file runs INSIDE the VS Code Extension Host.
// It connects to braid-fuzz via TCP and drives the extension's commands.

import * as vscode from "vscode";
import * as net from "net";
import * as fs from "fs";

const { fetch: braid_fetch } = require("braid-http");

const FUZZ_TCP_PORT = parseInt(process.env.BRAID_FUZZ_TCP_PORT || "4445");

// Log to a fixed file for debugging
const LOG_FILE = "/tmp/braid-fuzz-vscode-test.log";
function log(...args: any[]) {
  fs.appendFileSync(LOG_FILE, args.map(String).join(" ") + "\n");
}

// State for open-http / close-http (raw braid_fetch)
let currentFetch: { ac: AbortController } | null = null;

export async function run(): Promise<void> {
  fs.writeFileSync(LOG_FILE, `[run-fuzz] Starting at ${new Date().toISOString()}\n`);
  log("[run-fuzz] TCP port:", FUZZ_TCP_PORT);

  const resultsFile = process.env.BRAID_FUZZ_RESULTS_FILE;

  let socket: net.Socket;
  try {
    socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ host: "127.0.0.1", port: FUZZ_TCP_PORT }, () => resolve(s));
      s.on("error", reject);
    });
    log("[run-fuzz] Connected");
  } catch (e: any) {
    log("[run-fuzz] FAILED to connect:", e.message);
    throw e;
  }

  let testResults: any = null;
  let buf = "";

  socket.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) { continue; }
      try {
        const msg = JSON.parse(line);
        log("[run-fuzz] cmd:", msg.cmd, "id:", msg.id);
        handleCommand(socket, msg).then(() => {
          if (msg.cmd === "results") { testResults = msg; }
        }).catch((e: any) => log("[run-fuzz] error:", e.message));
      } catch (e: any) {
        log("[run-fuzz] parse error:", e.message);
      }
    }
  });

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (testResults) { clearInterval(check); resolve(); }
    }, 200);
  });

  socket.end();

  const summary = testResults.summary;
  if (resultsFile) {
    fs.writeFileSync(resultsFile, JSON.stringify(summary), "utf-8");
  }

  if (summary.failed > 0) {
    throw new Error(`${summary.failed} test(s) failed`);
  }
}

function sendMsg(socket: net.Socket, obj: any) {
  socket.write(JSON.stringify(obj) + "\n");
}

async function handleCommand(socket: net.Socket, msg: any) {
  const reply = (id: number, data?: any) => sendMsg(socket, { id, ok: true, ...data });

  try {
    switch (msg.cmd) {
      case "hello":
        reply(msg.id);
        break;

      // ── Simpleton commands ──────────────────────────────────────

      case "sync-text":
        await vscode.commands.executeCommand("braid.syncText", msg.url);
        await new Promise((r) => setTimeout(r, 100));
        reply(msg.id);
        break;

      case "edit":
        await vscode.commands.executeCommand(
          "braid.edit", msg.pos || 0, msg.len || 0, msg.text || ""
        );
        reply(msg.id);
        break;

      case "send-text": {
        const state = await vscode.commands.executeCommand<string>("braid.getText");
        reply(msg.id, { state: state || "" });
        break;
      }

      case "ack":
        await vscode.commands.executeCommand("braid.waitForAck");
        reply(msg.id);
        break;

      case "end-sync":
        await vscode.commands.executeCommand("braid.endSync");
        reply(msg.id);
        break;

      // ── Raw braid_fetch commands (http, subscriptions, reliable-updates) ──

      case "open-http": {
        const method = (msg.method || "GET").toUpperCase();
        const ac = new AbortController();
        let lastVersion: any = null;

        currentFetch = { ac };

        const fetchOpts: any = {
          method,
          headers: msg.headers || {},
          signal: ac.signal,
        };

        if (msg.subscribe) {
          fetchOpts.subscribe = true;
          fetchOpts.retry = () => true;
          fetchOpts.parents = () => lastVersion;
        }
        if (msg.heartbeats != null) { fetchOpts.heartbeats = msg.heartbeats; }

        if (msg.version) {
          fetchOpts.version = typeof msg.version === "string" ? [msg.version] : msg.version;
        }
        if (msg.parents) {
          fetchOpts.parents = typeof msg.parents === "string" ? [msg.parents] : msg.parents;
        }
        if (msg.patches) {
          fetchOpts.patches = msg.patches.map((p: any) => ({
            unit: p.unit || "text",
            range: p.range,
            content: p.content,
          }));
        }
        if (msg.peer) { fetchOpts.peer = msg.peer; }

        if (method === "PUT") {
          if (!fetchOpts.retry) { fetchOpts.retry = (res: any) => res.status !== 550; }

          (async () => {
            try {
              const r = await braid_fetch(msg.url, fetchOpts);
              sendMsg(socket, { event: "ack", data: { status: r.status } });
            } catch (e: any) {
              if (e.name === "AbortError") { return; }
              sendMsg(socket, { event: "error", data: { message: e.message || String(e) } });
            }
          })();
        } else {
          // GET subscription
          braid_fetch(msg.url, fetchOpts).then((res: any) => {
            res.subscribe((update: any) => {
              if (update.version) { lastVersion = update.version; }

              const item: any = {
                version: update.version || null,
                parents: update.parents || null,
              };
              if (update.patches) {
                item.patches = update.patches.map((p: any) => ({
                  range: p.range ? p.range.match(/\d+/g).map(Number) : null,
                  content: p.content_text,
                  unit: p.unit || null,
                }));
              }
              if (update.body != null) {
                item.body = update.body_text;
              }
              if (update.extra_headers) {
                item.extra_headers = update.extra_headers;
              }
              sendMsg(socket, { event: "update", data: item });
            }, (e: any) => {
              if (e.name === "AbortError") { return; }
              sendMsg(socket, { event: "error", data: { message: e.message || String(e) } });
            });
          }).catch((e: any) => {
            if (e.name === "AbortError") { return; }
            sendMsg(socket, { event: "error", data: { message: e.message || String(e) } });
          });
        }

        reply(msg.id);
        break;
      }

      case "close-http": {
        if (currentFetch) {
          currentFetch.ac.abort();
          currentFetch = null;
        }
        reply(msg.id);
        break;
      }

      case "results":
        reply(msg.id);
        break;

      default:
        sendMsg(socket, { id: msg.id, error: `unknown command: ${msg.cmd}` });
    }
  } catch (e: any) {
    sendMsg(socket, { id: msg.id, error: e.message });
  }
}

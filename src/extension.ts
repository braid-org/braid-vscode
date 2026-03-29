import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import * as vm from "vm";

// ---------------------------------------------------------------------------
// Load braid_fetch + simpleton_client from node_modules
// ---------------------------------------------------------------------------

const { fetch: braid_fetch } = require("braid-http");

const simpleton_path = path.join(
  __dirname, "..", "node_modules", "braid-text", "client", "simpleton-sync.js"
);
const simpleton_code = fs.readFileSync(simpleton_path, "utf8");
const sandbox: any = {
  braid_fetch,
  console: { ...console, log: (...args: any[]) => console.log("[simpleton]", ...args) },
  setTimeout, clearTimeout, setInterval, clearInterval,
  AbortController, TextDecoder, TextEncoder,
  crypto: globalThis.crypto || require("crypto"),
  Math, Error, TypeError, RangeError, ReferenceError,
  Promise, Array, Object, String, Number, Boolean,
  JSON, parseInt, parseFloat, isNaN, isFinite,
  Uint8Array, Map, Set, RegExp, Date,
  btoa: globalThis.btoa, atob: globalThis.atob, Buffer,
};
vm.createContext(sandbox);
vm.runInContext(simpleton_code, sandbox);
const simpleton_client: any = sandbox.simpleton_client;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURSOR_CONTENT_TYPE = "application/text-cursors+json";
const CURSOR_COLORS = [
  "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4",
  "#FFEAA7", "#DDA0DD", "#98D8C8", "#F7DC6F",
];

// ---------------------------------------------------------------------------
// Temp-file helpers
// ---------------------------------------------------------------------------

const tmpDir = path.join(os.tmpdir(), "braid-vscode");

function ensureTmpDir() {
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
}

function tmpFileForUrl(url: string): string {
  const parsed = new URL(url);
  const basename = path.basename(parsed.pathname) || "resource";
  return path.join(tmpDir, `${Date.now()}-${basename}`);
}

// ---------------------------------------------------------------------------
// Code-point / UTF-16 conversion helpers
// ---------------------------------------------------------------------------

function codepointToUtf16(str: string, cpOffset: number): number {
  let cp = 0, utf16 = 0;
  while (cp < cpOffset && utf16 < str.length) {
    const code = str.charCodeAt(utf16);
    utf16 += (code >= 0xD800 && code <= 0xDBFF) ? 2 : 1;
    cp++;
  }
  return utf16;
}

function utf16ToCodepoint(str: string, utf16Offset: number): number {
  let cp = 0, utf16 = 0;
  while (utf16 < utf16Offset && utf16 < str.length) {
    const code = str.charCodeAt(utf16);
    utf16 += (code >= 0xD800 && code <= 0xDBFF) ? 2 : 1;
    cp++;
  }
  return cp;
}

function codepointToPosition(doc: vscode.TextDocument, buffer: string, cpOffset: number): vscode.Position {
  return doc.positionAt(codepointToUtf16(buffer, cpOffset));
}


// ---------------------------------------------------------------------------
// Cursor transform (from spec)
// ---------------------------------------------------------------------------

interface CursorRange {
  from: number;  // code-point offset
  to: number;    // code-point offset
}

function transformPos(pos: number, delStart: number, delLen: number, insLen: number): number {
  if (delLen === 0) {
    return pos < delStart ? pos : pos + insLen;
  }
  if (pos <= delStart) { return pos; }
  if (pos <= delStart + delLen) { return delStart + insLen; }
  return pos - delLen + insLen;
}

function transformAllCursors(
  cursors: Map<string, CursorRange[]>,
  delStart: number, delLen: number, insLen: number
) {
  for (const ranges of cursors.values()) {
    for (const r of ranges) {
      r.from = transformPos(r.from, delStart, delLen, insLen);
      r.to = transformPos(r.to, delStart, delLen, insLen);
    }
  }
}

/** Compute a simple diff in code-point space between two strings */
function codepointDiff(oldStr: string, newStr: string): { start: number; delLen: number; insLen: number } | null {
  const oldChars = [...oldStr];
  const newChars = [...newStr];
  if (oldStr === newStr) { return null; }

  let prefix = 0;
  const minLen = Math.min(oldChars.length, newChars.length);
  while (prefix < minLen && oldChars[prefix] === newChars[prefix]) { prefix++; }

  let oldSuffix = oldChars.length;
  let newSuffix = newChars.length;
  while (oldSuffix > prefix && newSuffix > prefix
         && oldChars[oldSuffix - 1] === newChars[newSuffix - 1]) {
    oldSuffix--;
    newSuffix--;
  }

  return {
    start: prefix,
    delLen: oldSuffix - prefix,
    insLen: newSuffix - prefix,
  };
}

// ---------------------------------------------------------------------------
// Cursor state
// ---------------------------------------------------------------------------

interface CursorState {
  peerId: string;
  remoteCursors: Map<string, CursorRange[]>;
  localCursorRanges: CursorRange[];
  subscriptionAbort: AbortController | null;
  decorationTypes: Map<string, {
    cursorType: vscode.TextEditorDecorationType;
    selectionType: vscode.TextEditorDecorationType;
  }>;
  colorIndex: number;
  sendTimer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// Sync session state
// ---------------------------------------------------------------------------

interface SyncSession {
  simpleton: any;
  url: string;
  buffer: string;
  doc: vscode.TextDocument;
  editor: vscode.TextEditor;
  filePath: string;
  suppressSync: boolean;
  pendingPuts: number;
  ackWaiters: Array<() => void>;
  cursors: CursorState | null;
}

let activeSession: SyncSession | null = null;

/** Push the current buffer to the VS Code editor (fire-and-forget) */
function syncEditorToBuffer(session: SyncSession) {
  session.suppressSync = true;
  const fullRange = new vscode.Range(
    session.doc.positionAt(0),
    session.doc.positionAt(session.doc.getText().length)
  );
  const edit = new vscode.WorkspaceEdit();
  edit.replace(session.doc.uri, fullRange, session.buffer);
  vscode.workspace.applyEdit(edit).then(() => {
    session.suppressSync = false;
  });
}

// ---------------------------------------------------------------------------
// Cursor functions
// ---------------------------------------------------------------------------

async function detectCursorSupport(url: string): Promise<boolean> {
  try {
    const res = await braid_fetch(url, {
      method: "HEAD",
      headers: { Accept: CURSOR_CONTENT_TYPE },
    });
    return res.status === 200 &&
      (res.headers.get("content-type") || "").includes(CURSOR_CONTENT_TYPE);
  } catch {
    return false;
  }
}

function startCursorSubscription(session: SyncSession, url: string) {
  const cs = session.cursors!;
  cs.subscriptionAbort = new AbortController();

  braid_fetch(url, {
    subscribe: true,
    heartbeats: 10,
    signal: cs.subscriptionAbort.signal,
    retry: () => true,
    peer: cs.peerId,
    headers: { Accept: CURSOR_CONTENT_TYPE },
  }).then((res: any) => {
    res.subscribe((update: any) => {
      if (activeSession !== session) { return; }

      const bodyText: string = update.body_text ?? "";
      const contentRange: string | undefined =
        update.extra_headers?.["content-range"] ??
        (update.patches?.[0]?.range ? `json ${update.patches[0].range}` : undefined);

      if (contentRange) {
        // Partial update: single peer
        const peerMatch = contentRange.match(/"([^"]+)"/);
        if (!peerMatch) { return; }
        const peerId = peerMatch[1];
        if (peerId === cs.peerId) { return; }

        if (!bodyText.trim() && (!update.patches || !update.patches[0]?.content_text?.trim())) {
          // Empty content → peer disconnected
          cs.remoteCursors.delete(peerId);
        } else {
          try {
            const patchContent = update.patches?.[0]?.content_text ?? bodyText;
            const data = JSON.parse(patchContent);
            cs.remoteCursors.set(peerId, data);
          } catch { return; }
        }
      } else {
        // Full snapshot
        cs.remoteCursors.clear();
        if (bodyText.trim()) {
          try {
            const data = JSON.parse(bodyText);
            for (const [peerId, ranges] of Object.entries(data)) {
              if (peerId !== cs.peerId) {
                cs.remoteCursors.set(peerId, ranges as CursorRange[]);
              }
            }
          } catch { return; }
        }
        // Re-PUT our cursor on reconnect (server deletes on disconnect)
        if (cs.localCursorRanges.length > 0) {
          sendCursorPut(session);
        }
      }

      renderCursors(session);
    }, (_e: any) => {
      // Subscription error — retry handles reconnection
    });
  }).catch(() => {});
}

function sendCursorPut(session: SyncSession) {
  const cs = session.cursors;
  if (!cs) { return; }

  braid_fetch(session.url, {
    method: "PUT",
    headers: {
      "Content-Type": CURSOR_CONTENT_TYPE,
    },
    patches: [{
      unit: "json",
      range: `["${cs.peerId}"]`,
      content: JSON.stringify(cs.localCursorRanges),
    }],
  }).catch(() => {});
}

function throttledCursorSend(session: SyncSession) {
  const cs = session.cursors;
  if (!cs) { return; }
  if (cs.sendTimer) { return; }
  cs.sendTimer = setTimeout(() => {
    cs.sendTimer = null;
    sendCursorPut(session);
  }, 33);
}

function getOrCreateDecorationTypes(session: SyncSession, peerId: string) {
  const cs = session.cursors!;
  if (!cs.decorationTypes.has(peerId)) {
    const color = CURSOR_COLORS[cs.colorIndex % CURSOR_COLORS.length];
    cs.colorIndex++;

    const cursorType = vscode.window.createTextEditorDecorationType({
      borderStyle: "none none none solid",
      borderColor: color,
      borderWidth: "2px",
    });

    const selectionType = vscode.window.createTextEditorDecorationType({
      backgroundColor: color + "40",
    });

    cs.decorationTypes.set(peerId, { cursorType, selectionType });
  }
  return cs.decorationTypes.get(peerId)!;
}

function renderCursors(session: SyncSession) {
  const cs = session.cursors;
  if (!cs) { return; }

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.fsPath !== session.filePath) { return; }

  for (const [peerId, ranges] of cs.remoteCursors) {
    const { cursorType, selectionType } = getOrCreateDecorationTypes(session, peerId);

    const cursorDecs: vscode.DecorationOptions[] = [];
    const selDecs: vscode.DecorationOptions[] = [];

    for (const r of ranges) {
      const fromPos = codepointToPosition(session.doc, session.buffer, r.from);
      const toPos = codepointToPosition(session.doc, session.buffer, r.to);

      if (r.from === r.to) {
        cursorDecs.push({ range: new vscode.Range(fromPos, fromPos) });
      } else {
        const start = fromPos.isBefore(toPos) ? fromPos : toPos;
        const end = fromPos.isBefore(toPos) ? toPos : fromPos;
        selDecs.push({ range: new vscode.Range(start, end) });
        cursorDecs.push({ range: new vscode.Range(toPos, toPos) });
      }
    }

    editor.setDecorations(cursorType, cursorDecs);
    editor.setDecorations(selectionType, selDecs);
  }

  // Clear decorations for peers that disconnected
  for (const [peerId, types] of cs.decorationTypes) {
    if (!cs.remoteCursors.has(peerId)) {
      editor.setDecorations(types.cursorType, []);
      editor.setDecorations(types.selectionType, []);
      types.cursorType.dispose();
      types.selectionType.dispose();
      cs.decorationTypes.delete(peerId);
    }
  }
}

function cleanupCursors(session: SyncSession) {
  const cs = session.cursors;
  if (!cs) { return; }
  cs.subscriptionAbort?.abort();
  if (cs.sendTimer) { clearTimeout(cs.sendTimer); }
  for (const types of cs.decorationTypes.values()) {
    types.cursorType.dispose();
    types.selectionType.dispose();
  }
  session.cursors = null;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  ensureTmpDir();

  // --- braid.syncText: start syncing a URL with an editor buffer ----------
  context.subscriptions.push(
    vscode.commands.registerCommand("braid.syncText", async (url: string) => {
      if (activeSession) {
        cleanupCursors(activeSession);
        activeSession.simpleton.abort();
        activeSession = null;
      }

      const tmpFile = tmpFileForUrl(url);
      fs.writeFileSync(tmpFile, "", "utf-8");

      const doc = await vscode.workspace.openTextDocument(tmpFile);
      const editor = await vscode.window.showTextDocument(doc);

      const session: SyncSession = {
        simpleton: null,
        url,
        buffer: "",
        doc,
        editor,
        filePath: tmpFile,
        suppressSync: false,
        pendingPuts: 0,
        ackWaiters: [],
        cursors: null,
      };

      session.simpleton = simpleton_client(url, {
        get_state: () => session.buffer,
        on_state: (state: string) => {
          const oldBuffer = session.buffer;
          session.buffer = state;

          // Transform remote cursors based on the diff
          if (session.cursors && oldBuffer !== state) {
            const diff = codepointDiff(oldBuffer, state);
            if (diff) {
              transformAllCursors(session.cursors.remoteCursors, diff.start, diff.delLen, diff.insLen);
              renderCursors(session);
            }
          }

          syncEditorToBuffer(session);
        },
        on_error: (e: any) => {
          console.error("simpleton error:", e.message || e);
        },
        on_online: (online: boolean) => {
          console.log("simpleton online:", online);
        },
        on_ack: () => {
          session.pendingPuts--;
          if (session.pendingPuts <= 0) {
            session.pendingPuts = 0;
            for (const w of session.ackWaiters.splice(0)) w();
          }
        },
      });

      activeSession = session;

      // Feature-detect cursors and start subscription if supported
      detectCursorSupport(url).then((supported) => {
        if (!supported || activeSession !== session) { return; }

        session.cursors = {
          peerId: Math.random().toString(36).slice(2),
          remoteCursors: new Map(),
          localCursorRanges: [],
          subscriptionAbort: null,
          decorationTypes: new Map(),
          colorIndex: 0,
          sendTimer: null,
        };

        startCursorSubscription(session, url);
      });
    })
  );

  // --- braid.edit: simulate a user edit -----------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "braid.edit",
      async (pos: number, len: number, text: string) => {
        if (!activeSession) { return; }
        const s = activeSession;

        const chars = [...s.buffer];
        const clamped_pos = Math.min(pos || 0, chars.length);
        const clamped_len = Math.min(len || 0, chars.length - clamped_pos);

        // Transform remote cursors for this edit (code-point space)
        if (s.cursors) {
          transformAllCursors(s.cursors.remoteCursors, clamped_pos, clamped_len, [...(text || "")].length);
          renderCursors(s);
        }

        chars.splice(clamped_pos, clamped_len, ...(text || ""));
        s.buffer = chars.join("");

        syncEditorToBuffer(s);

        s.pendingPuts++;
        s.simpleton.changed();
      }
    )
  );

  // --- braid.getText: return current buffer text --------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("braid.getText", () => {
      if (!activeSession) { return ""; }
      return activeSession.buffer;
    })
  );

  // --- braid.waitForAck: block until all PUTs acknowledged ----------------
  context.subscriptions.push(
    vscode.commands.registerCommand("braid.waitForAck", async () => {
      if (!activeSession || activeSession.pendingPuts <= 0) { return; }
      await new Promise<void>((resolve) => {
        activeSession!.ackWaiters.push(resolve);
      });
    })
  );

  // --- braid.endSync: stop syncing ----------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("braid.endSync", () => {
      if (activeSession) {
        cleanupCursors(activeSession);
        activeSession.simpleton.abort();
      }
    })
  );

  // --- braid.open: the manual OPEN URL command ----------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("braid.open", async () => {
      const url = await vscode.window.showInputBox({
        prompt: "Enter URL to open (Braid sync)",
        placeHolder: "https://example.com/resource",
      });
      if (!url) { return; }
      await vscode.commands.executeCommand("braid.syncText", url);
      vscode.window.showInformationMessage(`Syncing ${url}`);
    })
  );

  // --- Listen for selection changes to send cursor updates ----------------
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!activeSession?.cursors) { return; }
      if (e.textEditor.document.uri.fsPath !== activeSession.filePath) { return; }

      const cs = activeSession.cursors;
      // Use the editor's actual text for conversion, not session.buffer,
      // since the editor content may differ from the buffer momentarily
      const editorText = activeSession.doc.getText();
      cs.localCursorRanges = e.selections.map(sel => ({
        from: utf16ToCodepoint(editorText, activeSession!.doc.offsetAt(sel.anchor)),
        to: utf16ToCodepoint(editorText, activeSession!.doc.offsetAt(sel.active)),
      }));

      throttledCursorSend(activeSession);
    })
  );

  // --- Re-render cursors when active editor changes ----------------------
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      if (activeSession?.cursors) { renderCursors(activeSession); }
    })
  );

  // --- Listen for document changes to call simpleton.changed() ------------
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!activeSession) { return; }
      if (activeSession.suppressSync) { return; }
      if (e.document.uri.fsPath !== activeSession.filePath) { return; }

      // Transform remote cursors for local edits
      if (activeSession.cursors && e.contentChanges.length > 0) {
        for (const change of e.contentChanges) {
          const delStartCp = utf16ToCodepoint(activeSession.buffer, change.rangeOffset);
          const delLenCp = [...activeSession.buffer.substring(
            change.rangeOffset, change.rangeOffset + change.rangeLength
          )].length;
          const insLenCp = [...change.text].length;
          transformAllCursors(activeSession.cursors.remoteCursors, delStartCp, delLenCp, insLenCp);
        }
        renderCursors(activeSession);
      }

      activeSession.buffer = e.document.getText();
      activeSession.pendingPuts++;
      activeSession.simpleton.changed();
    })
  );

  // --- Cleanup on close ---------------------------------------------------
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (!activeSession) { return; }
      if (doc.uri.fsPath !== activeSession.filePath) { return; }
      cleanupCursors(activeSession);
      activeSession.simpleton.abort();
      try { fs.unlinkSync(activeSession.filePath); } catch { /* ok */ }
      activeSession = null;
    })
  );
}

export function deactivate() {
  if (activeSession) {
    cleanupCursors(activeSession);
    try { activeSession.simpleton.abort(); } catch { /* ok */ }
    try { fs.unlinkSync(activeSession.filePath); } catch { /* ok */ }
    activeSession = null;
  }
}

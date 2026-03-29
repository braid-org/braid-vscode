# Braid-VSCode

Collaborative editing from VS Code to anything and everything using the
[Braid-HTTP](https://braid.org) protocol.

## Installation

Install from the VS Code Marketplace (coming soon), or clone and load
as a development extension:

```bash
git clone https://github.com/braid-org/braid-vscode.git
cd braid-vscode
npm install
npm run compile
```

Then press **F5** in VS Code to launch an Extension Development Host.

## How it works

Syncs VS Code buffers with HTTP resources.
Uses the [simpleton](https://braid.org/simpleton) merge algorithm.
Implements HTTP with braid-http and reads/writes Braid-HTTP in
TypeScript.

### Opening a URL

Open any braid-text resource:

    Ctrl+Shift+P → "Braid: OPEN URL" → https://dt.braid.org/foo

braid-vscode automatically connects and starts syncing.

Edits you make are pushed to the server immediately, and edits from
other clients appear in real time. Close the buffer to disconnect.

### Cursors

If the server supports collaborative cursors, braid-vscode
automatically subscribes to cursor updates. Remote cursors and
selections appear as colored highlights in the editor, and your cursor
position is broadcast to other clients.

## Libraries

braid-vscode depends on:

- **[braid-http](https://github.com/braid-org/braid-http)** — a
  Braid-HTTP client library. Subscribe to any Braid resource and
  receive streaming updates (209 Multiresponse parsing, automatic
  reconnection). Send versioned PUTs with patches.

- **[braid-text](https://github.com/braid-org/braid-text)** — a
  simpleton sync client. Connects to a braid-text resource and handles
  the full sync lifecycle: diffing, patching, version tracking, and
  digest verification.

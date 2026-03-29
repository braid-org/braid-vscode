// Outer launcher: starts braid-fuzz in server mode, then launches VS Code
// with our extension + test runner that connects via TCP.

import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { spawn } from "child_process";

// Use high random ports to avoid conflicts
const WS_PORT = 14444 + Math.floor(Math.random() * 1000);
const TCP_PORT = WS_PORT + 1;

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "./run-fuzz");

  const codeBin = path.join(
    extensionDevelopmentPath,
    ".vscode-test/vscode-darwin-arm64-1.112.0",
    "Visual Studio Code.app/Contents/Resources/app/bin/code"
  );

  const filter = process.argv[2] || "everything";

  console.log(`[launcher] Starting braid-fuzz (filter=${filter}, tcp=${TCP_PORT})...`);

  // Start braid-fuzz server
  const fuzz = spawn("braid-fuzz", [filter, "--port", String(WS_PORT), "--tcp-port", String(TCP_PORT)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  let fuzzOutput = "";
  fuzz.stdout?.on("data", (d) => {
    const s = d.toString();
    fuzzOutput += s;
    process.stdout.write(s);
  });
  fuzz.stderr?.on("data", (d) => {
    process.stderr.write(d.toString());
  });

  // Wait for the server to be ready
  await waitForOutput(() => fuzzOutput.includes("Waiting for"), "braid-fuzz startup", fuzz);

  console.log("[launcher] braid-fuzz ready. Launching VS Code...");

  // Isolated user-data-dir
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "braid-fuzz-test-"));
  const tmpExtDir = path.join(tmpUserData, "extensions");
  fs.mkdirSync(tmpExtDir, { recursive: true });

  // Launch VS Code (we don't wait for it — we wait for braid-fuzz results)
  const vscode = spawn(codeBin, [
    "--extensionDevelopmentPath=" + extensionDevelopmentPath,
    "--extensionTestsPath=" + extensionTestsPath,
    "--user-data-dir=" + tmpUserData,
    "--extensions-dir=" + tmpExtDir,
    "--new-window",
  ], {
    stdio: "ignore",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      BRAID_FUZZ_TCP_PORT: String(TCP_PORT),
    },
    detached: false,
  });

  vscode.on("error", (e) => console.error("[launcher] VS Code error:", e));

  // Wait for braid-fuzz to print "Results:" (it stays running after, so we detect output)
  await waitForOutput(() => fuzzOutput.includes("Results:"), "test results", fuzz, 120000);

  // Parse pass/fail from output
  const match = fuzzOutput.match(/(\d+) passed, (\d+) failed/);
  if (match && parseInt(match[2]) > 0) {
    process.exitCode = 1;
  }

  // Clean up
  fuzz.kill();
  try { vscode.kill(); } catch { /* ok */ }
  setTimeout(() => {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }, 500);
}

function waitForOutput(
  condition: () => boolean,
  label: string,
  proc: ReturnType<typeof spawn>,
  timeoutMs = 15000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(check);
      reject(new Error(`Timeout waiting for ${label}`));
    }, timeoutMs);
    const check = setInterval(() => {
      if (condition()) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve();
      }
    }, 100);
    proc.on("exit", () => {
      clearInterval(check);
      clearTimeout(timeout);
      if (condition()) resolve();
      else reject(new Error(`Process exited before ${label}`));
    });
  });
}

main().catch((err) => {
  console.error("[launcher] Fatal:", err);
  process.exit(1);
});

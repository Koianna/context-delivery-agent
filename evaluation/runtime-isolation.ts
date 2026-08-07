import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function isolateRuntime(projectRoot: string): () => void {
  const runtimeRoot = path.join(projectRoot, "runtime");
  const backupContainer = fs.mkdtempSync(path.join(os.tmpdir(), "context-agent-eval-runtime-"));
  const backupRoot = path.join(backupContainer, "runtime");
  const existed = fs.existsSync(runtimeRoot);
  if (existed) fs.cpSync(runtimeRoot, backupRoot, { recursive: true, preserveTimestamps: true });

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    if (existed) fs.cpSync(backupRoot, runtimeRoot, { recursive: true, preserveTimestamps: true });
    fs.rmSync(backupContainer, { recursive: true, force: true });
  };
  process.once("exit", restore);
  return restore;
}

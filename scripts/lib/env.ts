import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "./config.js";

export function loadLocalEnv(root = PROJECT_ROOT): void {
  for (const name of [".env", ".env.local"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    for (const rawLine of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = unquote(match[2].trim());
    }
  }
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

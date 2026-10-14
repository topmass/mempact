// Token count and message count of every transcript under a directory, largest first.
// node --experimental-strip-types bench/corpus-size.ts ~/.claude/projects [minBytes]
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { importTranscript } from "./import.ts";

const [root = `${process.env.HOME}/.claude/projects`, minBytes = "2000000"] = process.argv.slice(2);
const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "subagents") walk(p);
    } else if (name.endsWith(".jsonl") && statSync(p).size >= Number(minBytes)) files.push(p);
  }
};
walk(root);
const rows: [number, number, string][] = [];
for (const p of files) {
  try {
    const f = importTranscript(p);
    rows.push([f.messages.reduce((n, m) => n + estimateTokens(m), 0), f.messages.length, p]);
  } catch (e) {
    console.error("ERR", p, (e as Error).message.slice(0, 80));
  }
}
rows.sort((a, b) => b[0] - a[0]);
for (const r of rows) console.log(r.join("\t"));

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LLAMA_TARGETS,
  type LlamaTarget,
  llamaReleaseUrl,
  llamaTargetDir
} from "../packages/server/src/providers/local/llama-targets.ts";

const requested = process.argv.slice(2) as LlamaTarget[];
const targets = requested.length > 0 ? requested : (Object.keys(LLAMA_TARGETS) as LlamaTarget[]);

for (const target of targets) {
  if (!(target in LLAMA_TARGETS)) {
    throw new Error(`Unknown llama.cpp target "${target}". Expected one of: ${Object.keys(LLAMA_TARGETS).join(", ")}`);
  }

  const dest = llamaTargetDir(target);
  if (existsSync(join(dest, "llama-server"))) {
    console.log(`[fetch-llama] ${target}: already present at ${dest}`);
    continue;
  }

  const url = llamaReleaseUrl(target);
  const archive = join(tmpdir(), `olive-${target}.tar.gz`);
  console.log(`[fetch-llama] ${target}: downloading ${url}`);
  const download = Bun.spawnSync(["curl", "-fsSL", "--retry", "3", url, "-o", archive]);
  if (download.exitCode !== 0) {
    throw new Error(`Download failed for ${target}: ${download.stderr.toString()}`);
  }

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const tar = Bun.spawnSync(["tar", "-xzf", archive, "-C", dest, "--strip-components=1"]);
  rmSync(archive, { force: true });
  if (tar.exitCode !== 0) {
    throw new Error(`Extraction failed for ${target}: ${tar.stderr.toString()}`);
  }

  console.log(`[fetch-llama] ${target}: installed to ${dest}`);
}

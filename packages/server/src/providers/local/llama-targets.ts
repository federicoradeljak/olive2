import { join } from "node:path";

export const LLAMA_CPP_TAG = "b10453";

/** Release asset per bundled llama.cpp build, keyed by `<os>-<arch>-<backend>`. */
export const LLAMA_TARGETS = {
  "darwin-arm64-metal": `llama-${LLAMA_CPP_TAG}-bin-macos-arm64.tar.gz`,
  "linux-x64-vulkan": `llama-${LLAMA_CPP_TAG}-bin-ubuntu-vulkan-x64.tar.gz`,
  "linux-arm64-vulkan": `llama-${LLAMA_CPP_TAG}-bin-ubuntu-vulkan-arm64.tar.gz`
} as const;

export type LlamaTarget = keyof typeof LLAMA_TARGETS;

const PLATFORM_TO_TARGET: Record<string, LlamaTarget> = {
  "darwin-arm64": "darwin-arm64-metal",
  "linux-x64": "linux-x64-vulkan",
  "linux-arm64": "linux-arm64-vulkan"
};

/** Repo-root `vendor/llama/` directory where fetched builds are stored. */
export const LLAMA_VENDOR_DIR = join(import.meta.dir, "../../../../../vendor/llama");

export function currentLlamaTarget(): LlamaTarget | null {
  return PLATFORM_TO_TARGET[`${process.platform}-${process.arch}`] ?? null;
}

export function llamaTargetDir(target: LlamaTarget): string {
  return join(LLAMA_VENDOR_DIR, LLAMA_CPP_TAG, target);
}

export function llamaReleaseUrl(target: LlamaTarget): string {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_TAG}/${LLAMA_TARGETS[target]}`;
}

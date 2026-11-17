// Types for make.mjs, for the TypeScript that imports it (the shell's tests, the e2e specs).
export function bundleOf(name: string, manifest?: Record<string, unknown>): Uint8Array;
export function writePluginBundles(folder?: string): {
  reference: string;
  referenceV2: string;
  hostile: string;
};

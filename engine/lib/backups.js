// Backed-up copies of build-org components, and what was already in them.
// Text that was in a component before the ticket touched it is the product's
// own text (an example address in a help text, a support mailbox in an error
// message). The data guard must stop new addresses, not that old text.
import path from 'node:path';
import { layout } from './paths.js';
import { buildOrg } from './config.js';
import { refFromPath } from './metadata.js';
import { scanText } from './guards/data.js';
import { exists, listFiles, readText } from './util.js';

export const backupDir = (root, cfg, key) => path.join(layout(root).ticketDir(key), 'backup', buildOrg(cfg).name);

/** Backed-up copy of a source file (same component, same file name), or null. */
export function backupCopy(root, cfg, key, file) {
  const dir = backupDir(root, cfg, key);
  if (!exists(dir)) return null;
  const f = String(file).split(path.sep).join('/');
  const ref = refFromPath(f);
  if (!ref) return null;
  const hit = listFiles(dir).find((x) => refFromPath(x) === ref && path.basename(x) === path.basename(f));
  return hit ? path.join(dir, hit) : null;
}

/** Data-guard findings in a source file that were not already in its backed-up version. */
export function newFindings(root, cfg, key, absFile) {
  const hits = scanText(readText(absFile), cfg.safety);
  if (!hits.length) return hits;
  const old = backupCopy(root, cfg, key, absFile);
  if (!old) return hits;
  const before = new Set(scanText(readText(old), cfg.safety).map((f) => `${f.type}:${f.value.toLowerCase()}`));
  return hits.filter((f) => !before.has(`${f.type}:${f.value.toLowerCase()}`));
}

// Evidence ledger. Only the engine writes here. A claim made by an agent is
// accepted only when it points to an entry in this ledger.
import path from 'node:path';
import { layout } from './paths.js';
import { readJson, writeJson, nowIso, sha256, pad, fail } from './util.js';

export const KINDS = ['soql', 'apex-run', 'apex-test', 'retrieve', 'backup', 'deploy', 'parity', 'brain', 'doc', 'browser', 'file', 'analyzer', 'canary', 'describe'];

const dir = (root, key) => path.join(layout(root).ticketDir(key), 'evidence');
const indexFile = (root, key) => path.join(dir(root, key), 'index.json');

/** @returns {object[]} all evidence entries of a ticket, oldest first */
export const listEvidence = (root, key) => readJson(indexFile(root, key), []);
export const getEvidence = (root, key, id) => listEvidence(root, key).find((e) => e.id === id);
export const readEvidencePayload = (root, key, id) => readJson(path.join(dir(root, key), `${id}.json`));

/**
 * Record one piece of evidence.
 * @param {string} root
 * @param {string} key ticket key
 * @param {{kind: string, org?: string, command?: string, summary: string, ok?: boolean, actor?: string, meta?: object, payload?: unknown}} entry
 * @returns {object} the stored index entry (with id)
 */
export function addEvidence(root, key, entry) {
  if (!KINDS.includes(entry.kind)) fail(`Unknown evidence kind "${entry.kind}".`);
  const index = listEvidence(root, key);
  const id = `E${pad(index.length + 1)}`;
  const payload = entry.payload ?? null;
  const body = JSON.stringify(payload);
  const item = {
    id,
    kind: entry.kind,
    org: entry.org || null,
    actor: entry.actor || 'engine',
    at: nowIso(),
    ok: entry.ok !== false,
    command: entry.command || null,
    summary: entry.summary,
    sha256: sha256(body),
    meta: entry.meta || {},
  };
  writeJson(path.join(dir(root, key), `${id}.json`), { ...item, payload });
  index.push(item);
  writeJson(indexFile(root, key), index);
  return item;
}

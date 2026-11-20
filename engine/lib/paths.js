// Where things live. A workspace is the folder that contains orgtomo.config/.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, fail } from './util.js';

/** Root of the installed plugin (the repo). */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SPEC_DIR = path.join(PLUGIN_ROOT, 'spec');

/**
 * Find the workspace root: ORGTOMO_WORKSPACE, CLAUDE_PROJECT_DIR, or the
 * nearest parent of `start` that holds an orgtomo.config folder.
 * @returns {string|null}
 */
export function findWorkspace(start = process.cwd()) {
  for (const candidate of [process.env.ORGTOMO_WORKSPACE, start, process.env.CLAUDE_PROJECT_DIR]) {
    if (!candidate) continue;
    let dir = path.resolve(candidate);
    for (;;) {
      if (exists(path.join(dir, 'orgtomo.config'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export const requireWorkspace = (start) =>
  findWorkspace(start) || fail('No Orgtomo workspace found here. Run "orgtomo setup" in the folder you want to use.', 'NO_WORKSPACE');

/** All well-known locations inside a workspace. */
export function layout(root) {
  const vault = path.join(root, 'vault');
  const state = path.join(root, '.orgtomo', 'state');
  return {
    root,
    config: path.join(root, 'orgtomo.config'),
    state,
    ticketsState: path.join(state, 'tickets'),
    vault,
    tickets: path.join(vault, 'tickets'),
    claude: path.join(root, '.claude'),
    ticketDir: (key) => path.join(vault, 'tickets', key),
    ticketState: (key) => path.join(state, 'tickets', `${key}.json`),
    orgVault: (org) => path.join(vault, 'orgs', org),
  };
}

/** Workspace-relative path with forward slashes. */
export const rel = (root, p) => path.relative(root, path.resolve(root, p)).split(path.sep).join('/');

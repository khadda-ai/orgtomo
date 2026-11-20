// Obsidian is optional. The vault is plain Markdown and everything Orgtomo
// does works without it; Obsidian is one good way to look at the vault.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const OBSIDIAN_DOWNLOAD = 'https://obsidian.md/download';
export const OBSIDIAN_GIVES = [
  'Graph: see which component is connected to which.',
  'Canvas maps: for every object, what runs when a record is saved, as a picture.',
  'Bases: sortable, filterable tables of components and tickets.',
  'Backlinks: click from a field to every flow, class and rule that uses it.',
  'Search across the whole vault, and a place for your own notes.',
];
export const OBSIDIAN_DOES_NOT_GIVE = [
  'An assistant of its own: Obsidian has no built-in AI. The notes are written by Orgtomo and its agents.',
  'Anything Orgtomo needs: the engine never depends on Obsidian running.',
];
export const OBSIDIAN_FIRST_OPEN = [
  'Open Obsidian.',
  'Choose "Open folder as vault" and pick the vault folder of this workspace.',
  'Open Home.md. For the graph, open Graph view and add colour groups by path, for example path:orgs/<org>/facts/Flow.',
];

const onPath = (bin) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' }).status === 0;

export function obsidianStatus(root) {
  const apps = [path.join('/Applications', 'Obsidian.app'), path.join(os.homedir(), 'Applications', 'Obsidian.app')];
  const app = process.platform === 'darwin' ? apps.find((p) => fs.existsSync(p)) || null : null;
  const installed = Boolean(app) || onPath('obsidian');
  return {
    installed, app, command_line: onPath('obsidian'), homebrew: onPath('brew'),
    vault: root ? path.join(root, 'vault') : null,
    vault_opened_before: root ? fs.existsSync(path.join(root, 'vault', '.obsidian')) : false,
    gives: OBSIDIAN_GIVES, does_not_give: OBSIDIAN_DOES_NOT_GIVE, first_open: OBSIDIAN_FIRST_OPEN,
  };
}

/**
 * Install Obsidian when a package manager is there to do it; otherwise say
 * where to get it. Nothing is downloaded behind the human's back.
 */
export function obsidianInstall(root, { run = spawnSync } = {}) {
  const s = obsidianStatus(root);
  if (s.installed) return { ...s, did: 'nothing', say: 'Obsidian is already installed.' };
  if (process.platform === 'darwin' && s.homebrew) {
    const r = run('brew', ['install', '--cask', 'obsidian'], { stdio: 'inherit' });
    return { ...obsidianStatus(root), did: 'brew install --cask obsidian', ok: r.status === 0, say: r.status === 0 ? 'Installed. Now open it once by hand (see first_open).' : `Homebrew could not install it. Download it yourself: ${OBSIDIAN_DOWNLOAD}` };
  }
  return { ...s, did: 'nothing', say: `No package manager was found to install it for you. Download the installer yourself from ${OBSIDIAN_DOWNLOAD}, then follow first_open.` };
}

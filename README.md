# bb-plugin-ssh

Browse and edit files on remote servers over SSH, right inside bb — like the VS Code SFTP extension.

- **SSH** page in the sidebar: pick a host from `~/.ssh/config`, walk the directory tree, open a file in bb's source viewer, click «Править» to edit in CodeMirror (syntax highlighting in bb's code theme) and «Сохранить» (or Cmd+S) to write it back.
- The root folder typed above the tree is remembered per host in the plugin's server storage, so it follows you across devices.
- Click a folder in the tree to make it current; the bar above the tree creates an empty file there (+) or uploads a file from your device (up to 20 MB, with a confirm before replacing an existing one).
- The same bar creates a folder in the current folder, renames the current folder and deletes it with everything inside after showing how many entries it holds (not the root; the server refuses `/`, first-level folders like `/var`, and paths with `.`/`..`).
- The file header renames or moves the open file: edit its full path, or end it with `/` to move it into that folder under the same name. It never replaces an existing name and reports a missing target folder.
- The terminal button in that bar (and in the file header, for the file's folder) opens an interactive `ssh -t <host>` session already `cd`'d into the current folder, as a bb terminal tab in the page's side panel (closing the tab ends the session).
- The download button in the file header saves the open file to your device (up to 20 MB).
- The trash button deletes the open file after a second confirmation click.
- Saving is guarded with a three-way merge: if the file changed on the server since you opened it, nothing is written; your edits are merged with the server version (`merge.ts`, diff3). Non-overlapping changes merge automatically; overlapping ones are marked `<<<<<<< ваши правки` / `>>>>>>> сервер`, and saving stays blocked until the markers are gone or you pick «Оставить мою версию» / «Взять с сервера».
- Deleting is guarded the same way: a file changed on the server since you opened it is not deleted.
- «Связать с локальной папкой» under the folder field links a host to a project folder on the bb machine (for example `~/Documents/dev/agents` ⇄ `/var/www/agents`), stored per host in plugin storage. An open file inside the remote folder then shows its local twin (same relative path) as `совпадает` / `отличается` / `нет в проекте`, with «Сравнить» (diff server → local), «В проект» (write the server version locally, creating folders) and «На сервер» (upload the local version). Both directions ask before replacing, refuse if the other side changed since it was read, and refuse paths that would leave either folder (`..`, `.`, `//`).
- In a linked folder the tree marks each file against its local twin: an orange `●` (and orange name) when the content differs, a grey `○` when the file is missing locally. Folders get the worst mark of anything inside them, recursively. Expanding a folder runs one `find … | sha256sum` over its whole subtree (files up to 2 MB), skipping `.git`, `node_modules`, `vendor`, `storage`, `.idea`, `.vscode`, `.cache`, `.next`, `.turbo`, `.venv`, `venv`, `__pycache__`; the result is cached for 15 s, so expanding subfolders reuses it. Inside a skipped folder only the files of the open level are marked. Saving, «В проект», «На сервер» and other writes through the plugin drop the cache and refresh every mark; edits made only on the local side show up after the tree refresh button.
- In a thread, the side panel's «+» → Actions → **SSH** opens the same browser as a panel tab (tree, then the file with a back button). If the thread's folder (its environment or the project's source folder) is linked to a host, the tab opens that host in the matching remote folder; otherwise it starts with the last picked host. Terminals opened from this tab belong to the thread and open in its panel.
- Agent tools `ssh_list` and `ssh_read` (read-only) let agents inspect remote files; `ssh_list` without a path starts at the remembered root.

## How it connects

The plugin runs the system `ssh` binary, so `~/.ssh/config`, keys, `ssh-agent`, `known_hosts` and `ProxyJump` work as they do in your terminal. The plugin stores no credentials.

- `BatchMode=yes`: no password prompts. Use keys loaded into the agent.
- `ControlMaster=auto`, `ControlPersist=300`: one TCP connection per host is reused for 5 minutes; sockets live at `~/.ssh/bb-ssh-*`.
- Only hosts listed as `Host` aliases in `~/.ssh/config` are allowed (wildcards are skipped, `Include` is not followed).
- The remote side needs a POSIX shell, GNU `find` (`-printf`), `head`, `sha256sum` — any common Linux server.

## Limits

- Files up to 5 MB; binary files are not shown.
- Directory listings stop at 5000 entries.
- Saving rewrites the file in place (`cat > file`), keeping its owner and permissions; it is not atomic.

## Develop

```
npm install --include=dev --ignore-scripts
npm test
npx tsc --noEmit
bb plugin install .
bb plugin dev
```

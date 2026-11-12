---
name: ssh
description: Inspect files on the user's remote servers (Host aliases from ~/.ssh/config) with the read-only ssh_list and ssh_read tools.
---

# Remote files over SSH

Use the `ssh_list` and `ssh_read` tools when you need to inspect a file or a directory on one of the user's servers.

- `ssh_list` without `host` returns the Host aliases from `~/.ssh/config`. Use one of them as `host`.
- `ssh_list` with `host` and no `path` lists the remote home directory. `path` must be absolute.
- `ssh_read` returns up to 100000 characters of a text file. When the reply ends with `continue with offset=N`, call it again with `offset: N`.
- Files over 5 MB and binary files are not returned.

The tools are read-only. To change a remote file, tell the user to open the **SSH** page in the bb sidebar and use "Править". Do not change remote files any other way unless the user explicitly asks.

Connections use the system `ssh` with `BatchMode=yes`: keys and the ssh-agent work, while password or passphrase prompts fail. If a call fails with `Permission denied`, the user must add the key to the agent (`ssh-add`).

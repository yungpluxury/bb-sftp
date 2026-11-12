Browse and edit files on your servers without leaving bb.

## What you get

- An **SSH** page in the left sidebar: choose a server from `~/.ssh/config`, walk its folders, open files in bb's code viewer, and edit and save them.
- Conflict-safe saving: a file changed on the server since you opened it is never overwritten.
- Read-only `ssh_list` and `ssh_read` tools so agents can look at remote files too.

## How it works

The plugin calls your system `ssh`, so your existing config, keys and ssh-agent are used as-is. It stores no passwords or keys.

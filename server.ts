import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  createLocalHasher,
  findLinkTarget,
  type Link,
  localPathFor,
  readLocal,
  resolveLocalDir,
  sha256Hex,
  summarizeByChild,
  type SyncState,
  writeLocal,
} from "./local.ts";
import {
  countDirEntries,
  deleteRemoteDir,
  deleteRemoteFile,
  downloadRemoteFile,
  listConfiguredHosts,
  listDir,
  makeRemoteDir,
  MAX_FILE_BYTES,
  MAX_HASHED_BYTES,
  MAX_TRANSFER_BYTES,
  remoteDirHashes,
  remoteTreeHashes,
  SCAN_EXCLUDED_DIRS,
  putRemoteFile,
  readRemoteFile,
  renameRemote,
  shQuote,
  writeRemoteFile,
} from "./ssh.ts";

const AGENT_READ_LIMIT = 100_000;
const DIR_CHANGED = "dir-changed";
const LINKS_CHANGED = "links-changed";
const SYNC_CHANGED = "sync-changed";
const SCAN_TTL_MS = 15_000;

const linkSchema = z.object({ local: z.string(), remote: z.string() });

const hostSchema = z.string().min(1).max(255);
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith("/") && !value.includes("\0"), "Нужен абсолютный путь");
const dirPath = z
  .string()
  .max(4096)
  .refine(
    (value) => value === "" || (value.startsWith("/") && !value.includes("\0")),
    "Нужен абсолютный путь или пустая строка",
  );

const entrySchema = z.object({
  name: z.string(),
  kind: z.enum(["dir", "file", "other"]),
  link: z.boolean(),
  size: z.number(),
  mtimeMs: z.number(),
});
export type RemoteEntry = z.infer<typeof entrySchema>;

export const rpcContract = defineRpcContract({
  ssh_hosts: {
    input: z.null(),
    output: z.object({
      hosts: z.array(z.string()),
      roots: z.record(z.string(), z.string()),
      links: z.record(z.string(), linkSchema),
    }),
  },
  ssh_set_link: {
    input: z.object({ host: hostSchema, local: z.string().max(4096), remote: dirPath }),
    output: z.object({ links: z.record(z.string(), linkSchema) }),
  },
  ssh_local_status: {
    input: z.object({ host: hostSchema, path: absolutePath }),
    output: z.discriminatedUnion("linked", [
      z.object({ linked: z.literal(false) }),
      z.object({
        linked: z.literal(true),
        localPath: z.string(),
        exists: z.boolean(),
        sha256: z.string().nullable(),
        content: z.string().nullable(),
      }),
    ]),
  },
  ssh_dir_diff: {
    input: z.object({ host: hostSchema, path: absolutePath }),
    output: z.object({
      linked: z.boolean(),
      statuses: z.record(z.string(), z.enum(["same", "differs", "missing"])),
    }),
  },
  ssh_pull: {
    input: z.object({ host: hostSchema, path: absolutePath, expectedLocalSha256: z.string().nullable() }),
    output: z.object({ outcome: z.enum(["written", "conflict"]) }),
  },
  ssh_push: {
    input: z.object({ host: hostSchema, path: absolutePath, expectedSha256: z.string().regex(/^[0-9a-f]{64}$/) }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("written"), sha256: z.string() }),
      z.object({ outcome: z.literal("conflict"), currentSha256: z.string().nullable() }),
    ]),
  },
  ssh_set_root: {
    input: z.object({ host: hostSchema, path: dirPath }),
    output: z.object({ roots: z.record(z.string(), z.string()) }),
  },
  ssh_list: {
    input: z.object({ host: hostSchema, path: dirPath }),
    output: z.object({
      path: z.string(),
      entries: z.array(entrySchema),
      truncated: z.boolean(),
    }),
  },
  ssh_read: {
    input: z.object({ host: hostSchema, path: absolutePath }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("text"), content: z.string(), sha256: z.string(), size: z.number() }),
      z.object({ kind: z.literal("binary"), sha256: z.string(), size: z.number() }),
    ]),
  },
  ssh_download: {
    input: z.object({ host: hostSchema, path: absolutePath }),
    output: z.object({ base64: z.string(), size: z.number() }),
  },
  ssh_put: {
    input: z.object({
      host: hostSchema,
      path: absolutePath,
      base64: z.string().max(Math.ceil(MAX_TRANSFER_BYTES / 3) * 4),
      overwrite: z.boolean(),
    }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("written") }),
      z.object({ outcome: z.literal("exists") }),
    ]),
  },
  ssh_open_terminal: {
    input: z.object({ host: hostSchema, dir: dirPath, threadId: z.string().min(1).nullable().optional() }),
    output: z.object({ terminalId: z.string() }),
  },
  ssh_thread_target: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ host: z.string(), dir: z.string() }).nullable(),
  },
  ssh_mkdir: {
    input: z.object({ host: hostSchema, path: absolutePath }),
    output: z.object({ outcome: z.enum(["created", "exists"]) }),
  },
  ssh_rename: {
    input: z.object({ host: hostSchema, from: absolutePath, to: absolutePath }),
    output: z.object({ outcome: z.enum(["renamed", "exists", "missing", "nodir"]) }),
  },
  ssh_dir_info: {
    input: z.object({ host: hostSchema, path: absolutePath }),
    output: z.object({ entries: z.number(), capped: z.boolean() }),
  },
  ssh_rmdir: {
    input: z.object({ host: hostSchema, path: absolutePath }),
    output: z.object({ outcome: z.enum(["deleted", "missing"]) }),
  },
  ssh_delete: {
    input: z.object({
      host: hostSchema,
      path: absolutePath,
      expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("deleted") }),
      z.object({ outcome: z.literal("conflict"), currentSha256: z.string().nullable() }),
    ]),
  },
  ssh_write: {
    input: z.object({
      host: hostSchema,
      path: absolutePath,
      content: z.string(),
      expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("written"), sha256: z.string() }),
      z.object({ outcome: z.literal("conflict"), currentSha256: z.string().nullable() }),
    ]),
  },
});

function describeEntry(entry: RemoteEntry): string {
  const name = entry.kind === "dir" ? `${entry.name}/` : entry.name;
  const link = entry.link ? " (symlink)" : "";
  const size = entry.kind === "file" ? `\t${entry.size}` : "";
  return `${name}${link}${size}`;
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return "path must be absolute";
  return error instanceof Error ? error.message : String(error);
}

export default async function plugin(bb: BbPluginApi) {
  const readRoots = async () => (await bb.storage.kv.get<Record<string, string>>("roots")) ?? {};
  const readLinks = async () => (await bb.storage.kv.get<Record<string, Link>>("links")) ?? {};

  const hashLocal = createLocalHasher(MAX_HASHED_BYTES);
  const scans = new Map<string, { host: string; dir: string; at: number; result: Promise<Map<string, string>> }>();

  async function scanTree(host: string, dir: string): Promise<Map<string, string>> {
    const now = Date.now();
    for (const [key, scan] of scans) if (now - scan.at > SCAN_TTL_MS) scans.delete(key);
    const covering = [...scans.values()].find(
      (scan) => scan.host === host && (scan.dir === dir || dir.startsWith(scan.dir === "/" ? "/" : `${scan.dir}/`)),
    );
    const scan = covering ?? { host, dir, at: now, result: remoteTreeHashes(host, dir) };
    if (covering === undefined) scans.set(`${host}\n${dir}`, scan);
    const all = await scan.result.catch(async () => {
      scans.delete(`${scan.host}\n${scan.dir}`);
      return remoteDirHashes(host, dir);
    });
    if (scan.dir === dir) return all;
    const prefix = `${dir.slice(scan.dir === "/" ? 1 : scan.dir.length + 1)}/`;
    return new Map(
      [...all].filter(([relative]) => relative.startsWith(prefix)).map(([relative, sha]) => [relative.slice(prefix.length), sha]),
    );
  }

  async function requireLocalPath(host: string, path: string): Promise<string> {
    const link = (await readLinks())[host];
    const localPath = link === undefined ? null : localPathFor(link, path);
    if (localPath === null) throw new Error("Файл вне связанной папки");
    return localPath;
  }

  bb.rpc.register(rpcContract, {
    ssh_hosts: async () => ({
      hosts: await listConfiguredHosts(),
      roots: await readRoots(),
      links: await readLinks(),
    }),
    ssh_set_link: async ({ host, local, remote }) => {
      const links = await readLinks();
      if (local.trim() === "") {
        delete links[host];
      } else {
        if (remote === "") throw new Error("Укажите удалённую папку");
        links[host] = { local: await resolveLocalDir(local), remote: remote.replace(/\/+$/, "") || "/" };
      }
      await bb.storage.kv.set("links", links);
      bb.realtime.publish(LINKS_CHANGED, { host });
      return { links };
    },
    ssh_local_status: async ({ host, path }) => {
      const link = (await readLinks())[host];
      const localPath = link === undefined ? null : localPathFor(link, path);
      if (localPath === null) return { linked: false as const };
      const data = await readLocal(localPath, MAX_TRANSFER_BYTES);
      const text = data !== null && data.length <= MAX_FILE_BYTES && !data.subarray(0, 8192).includes(0);
      return {
        linked: true as const,
        localPath,
        exists: data !== null,
        sha256: data === null ? null : sha256Hex(data),
        content: text ? data.toString("utf8") : null,
      };
    },
    ssh_dir_diff: async ({ host, path }) => {
      const link = (await readLinks())[host];
      const remote = link?.remote.replace(/\/+$/, "") || "/";
      if (link === undefined || (path !== remote && localPathFor(link, path) === null)) {
        return { linked: false, statuses: {} };
      }
      const insideExcluded = path
        .slice(remote.length)
        .split("/")
        .some((segment) => SCAN_EXCLUDED_DIRS.includes(segment));
      const sums = insideExcluded ? await remoteDirHashes(host, path) : await scanTree(host, path);
      const files: [string, SyncState][] = [];
      for (const [relative, remoteSha] of sums) {
        const localPath = localPathFor(link, path === "/" ? `/${relative}` : `${path}/${relative}`);
        if (localPath === null) continue;
        const localSha = await hashLocal(localPath);
        files.push([relative, localSha === null ? "missing" : localSha === remoteSha ? "same" : "differs"]);
      }
      return { linked: true, statuses: summarizeByChild(files) };
    },
    ssh_pull: async ({ host, path, expectedLocalSha256 }) => {
      const localPath = await requireLocalPath(host, path);
      const data = await downloadRemoteFile(host, path);
      const outcome = await writeLocal(localPath, data, expectedLocalSha256, MAX_TRANSFER_BYTES);
      bb.log.info(`ssh_pull ${host}:${path} -> ${localPath} ${outcome}`);
      if (outcome === "written") publishDirChanged(host, path);
      return { outcome };
    },
    ssh_push: async ({ host, path, expectedSha256 }) => {
      const localPath = await requireLocalPath(host, path);
      const data = await readLocal(localPath, MAX_TRANSFER_BYTES);
      if (data === null) throw new Error(`Локального файла «${localPath}» нет`);
      const result = await writeRemoteFile(host, path, data, expectedSha256, MAX_TRANSFER_BYTES);
      bb.log.info(`ssh_push ${localPath} -> ${host}:${path} ${result.outcome}`);
      if (result.outcome === "written") publishDirChanged(host, path);
      return result;
    },
    ssh_set_root: async ({ host, path }) => {
      const roots = { ...(await readRoots()), [host]: path };
      if (path === "") delete roots[host];
      await bb.storage.kv.set("roots", roots);
      return { roots };
    },
    ssh_list: ({ host, path }) => listDir(host, path),
    ssh_read: ({ host, path }) => readRemoteFile(host, path),
    ssh_write: async ({ host, path, content, expectedSha256 }) => {
      const result = await writeRemoteFile(host, path, content, expectedSha256);
      bb.log.info(`ssh_write ${host}:${path} ${result.outcome}`);
      if (result.outcome === "written") publishDirChanged(host, path);
      return result;
    },
    ssh_delete: async ({ host, path, expectedSha256 }) => {
      const result = await deleteRemoteFile(host, path, expectedSha256);
      bb.log.info(`ssh_delete ${host}:${path} ${result.outcome}`);
      if (result.outcome === "deleted") publishDirChanged(host, path);
      return result;
    },
    ssh_thread_target: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      const candidates: string[] = [];
      if (thread.environmentId !== null) {
        const { path } = await bb.sdk.environments.get({ environmentId: thread.environmentId });
        if (path !== null) candidates.push(path);
      }
      if (thread.projectId !== null) {
        const project = await bb.sdk.projects.get({ projectId: thread.projectId });
        for (const source of project.sources) if (source.path !== null) candidates.push(source.path);
      }
      return findLinkTarget(await readLinks(), candidates);
    },
    ssh_open_terminal: async ({ host, dir, threadId }) => {
      if (!(await listConfiguredHosts()).includes(host)) {
        throw new Error(`Хоста «${host}» нет в ~/.ssh/config`);
      }
      const { primaryHostId } = await bb.sdk.system.config();
      if (primaryHostId === null) throw new Error("bb не знает свою машину, терминал открыть нельзя");
      const cd = dir === "" ? "" : `cd -- ${shQuote(dir)}; `;
      const terminal = await bb.sdk.terminals.create({
        cols: 120,
        rows: 32,
        title: `ssh ${host}${dir === "" ? "" : `:${dir}`}`,
        scope:
          threadId === null || threadId === undefined
            ? { kind: "host_path", hostId: primaryHostId, cwd: null }
            : { kind: "thread", threadId },
        start: { mode: "argv", argv: ["ssh", "-t", host, `${cd}exec "\${SHELL:-/bin/sh}" -l`] },
      });
      return { terminalId: terminal.id };
    },
    ssh_mkdir: async ({ host, path }) => {
      const result = await makeRemoteDir(host, path);
      bb.log.info(`ssh_mkdir ${host}:${path} ${result.outcome}`);
      if (result.outcome === "created") publishDirChanged(host, path);
      return result;
    },
    ssh_rename: async ({ host, from, to }) => {
      const result = await renameRemote(host, from, to);
      bb.log.info(`ssh_rename ${host}:${from} -> ${to} ${result.outcome}`);
      if (result.outcome === "renamed") {
        publishDirChanged(host, from);
        publishDirChanged(host, to);
      }
      return result;
    },
    ssh_dir_info: ({ host, path }) => countDirEntries(host, path),
    ssh_rmdir: async ({ host, path }) => {
      const result = await deleteRemoteDir(host, path);
      bb.log.info(`ssh_rmdir ${host}:${path} ${result.outcome}`);
      if (result.outcome === "deleted") publishDirChanged(host, path);
      return result;
    },
    ssh_download: async ({ host, path }) => {
      const data = await downloadRemoteFile(host, path);
      return { base64: data.toString("base64"), size: data.length };
    },
    ssh_put: async ({ host, path, base64, overwrite }) => {
      const result = await putRemoteFile(host, path, Buffer.from(base64, "base64"), overwrite);
      bb.log.info(`ssh_put ${host}:${path} ${result.outcome}`);
      if (result.outcome === "written") publishDirChanged(host, path);
      return result;
    },
  });

  function publishDirChanged(host: string, filePath: string) {
    for (const [key, scan] of scans) if (scan.host === host) scans.delete(key);
    bb.realtime.publish(DIR_CHANGED, { host, dir: filePath.slice(0, filePath.lastIndexOf("/")) || "/" });
    bb.realtime.publish(SYNC_CHANGED, { host });
  }

  bb.agents.registerTool({
    name: "ssh_list",
    description:
      "List a directory on a remote server over SSH (read-only). host is a Host alias from the user's ~/.ssh/config; omit host to list the aliases. path is absolute; omit it for the remote home directory.",
    instructions:
      "To inspect files on a remote server from ~/.ssh/config, use ssh_list and ssh_read. They are read-only.",
    presentation: { label: { pending: "Listing remote directory", completed: "Listed remote directory" } },
    parameters: z.object({ host: z.string().optional(), path: z.string().optional() }),
    async execute({ host, path }) {
      try {
        if (host === undefined || host === "") {
          const hosts = await listConfiguredHosts();
          return hosts.length === 0 ? "No hosts in ~/.ssh/config." : `Hosts:\n${hosts.join("\n")}`;
        }
        const result = await listDir(host, dirPath.parse(path ?? (await readRoots())[host] ?? ""));
        const text = [
          `${host}:${result.path}`,
          ...result.entries.map(describeEntry),
          ...(result.truncated ? ["… list truncated"] : []),
        ].join("\n");
        return text.slice(0, AGENT_READ_LIMIT);
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  });

  bb.agents.registerTool({
    name: "ssh_read",
    description:
      "Read a text file on a remote server over SSH (read-only). host is a Host alias from ~/.ssh/config, path is absolute. Returns at most 100000 characters starting at offset.",
    presentation: { label: { pending: "Reading remote file", completed: "Read remote file" } },
    parameters: z.object({
      host: z.string().min(1),
      path: z.string().min(1),
      offset: z.number().int().min(0).optional(),
    }),
    async execute({ host, path, offset }) {
      try {
        const result = await readRemoteFile(host, absolutePath.parse(path));
        if (result.kind === "binary") return `Binary file, ${result.size} bytes — not shown.`;
        const start = offset ?? 0;
        const end = Math.min(start + AGENT_READ_LIMIT, result.content.length);
        const tail =
          end < result.content.length
            ? `\n… truncated, continue with offset=${end} (total ${result.content.length})`
            : "";
        return result.content.slice(start, end) + tail;
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  });
}

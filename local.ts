import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export type Link = { local: string; remote: string };

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function localPathFor(link: Link, remotePath: string): string | null {
  const remote = link.remote.replace(/\/+$/, "") || "/";
  const prefix = remote === "/" ? "/" : `${remote}/`;
  if (!remotePath.startsWith(prefix)) return null;
  const parts = remotePath.slice(prefix.length).split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  const root = resolve(expandHome(link.local));
  const target = resolve(root, ...parts);
  return target.startsWith(root + sep) ? target : null;
}

export function findLinkTarget(
  links: Record<string, Link>,
  localPaths: string[],
): { host: string; dir: string } | null {
  for (const candidate of localPaths) {
    const path = resolve(candidate);
    for (const [host, link] of Object.entries(links)) {
      const local = resolve(expandHome(link.local));
      const remote = link.remote.replace(/\/+$/, "") || "/";
      if (path === local || local.startsWith(path + sep)) return { host, dir: remote };
      if (path.startsWith(local + sep)) {
        const relative = path.slice(local.length + 1).split(sep).join("/");
        return { host, dir: remote === "/" ? `/${relative}` : `${remote}/${relative}` };
      }
    }
  }
  return null;
}

export async function resolveLocalDir(path: string): Promise<string> {
  const absolute = resolve(expandHome(path.trim()));
  const info = await stat(absolute).catch(() => null);
  if (info === null || !info.isDirectory()) throw new Error(`Локальной папки «${absolute}» нет`);
  return absolute;
}

export async function readLocal(path: string, maxBytes: number): Promise<Buffer | null> {
  const info = await stat(path).catch(() => null);
  if (info === null) return null;
  if (!info.isFile()) throw new Error(`Локально «${path}» – не файл`);
  if (info.size > maxBytes) throw new Error(`Локальный файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ`);
  return readFile(path);
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export type SyncState = "same" | "differs" | "missing";

const SEVERITY: Record<SyncState, number> = { same: 0, missing: 1, differs: 2 };

export function summarizeByChild(files: Iterable<[string, SyncState]>): Record<string, SyncState> {
  const result: Record<string, SyncState> = {};
  for (const [relative, state] of files) {
    const slash = relative.indexOf("/");
    const child = slash === -1 ? relative : relative.slice(0, slash);
    const current = result[child];
    if (current === undefined || SEVERITY[state] > SEVERITY[current]) result[child] = state;
  }
  return result;
}

export function createLocalHasher(maxBytes: number) {
  const cache = new Map<string, { size: number; mtimeMs: number; sha: string }>();
  return async (path: string): Promise<string | null | "unreadable"> => {
    const info = await stat(path).catch(() => null);
    if (info === null) return null;
    if (!info.isFile() || info.size > maxBytes) return "unreadable";
    const cached = cache.get(path);
    if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.sha;
    const sha = sha256Hex(await readFile(path));
    cache.set(path, { size: info.size, mtimeMs: info.mtimeMs, sha });
    return sha;
  };
}

export async function writeLocal(
  path: string,
  data: Buffer,
  expectedSha256: string | null,
  maxBytes: number,
): Promise<"written" | "conflict"> {
  const current = await readLocal(path, maxBytes);
  const currentSha = current === null ? null : sha256Hex(current);
  if (currentSha !== expectedSha256) return "conflict";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  return "written";
}

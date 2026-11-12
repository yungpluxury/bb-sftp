import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TRANSFER_BYTES = 20 * 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 180_000;
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const MAX_LIST_ENTRIES = 5000;

export type Entry = {
  name: string;
  kind: "dir" | "file" | "other";
  link: boolean;
  size: number;
  mtimeMs: number;
};

export type ReadResult =
  | { kind: "text"; content: string; sha256: string; size: number }
  | { kind: "binary"; sha256: string; size: number };

export type DeleteResult =
  | { outcome: "deleted" }
  | { outcome: "conflict"; currentSha256: string | null };

export type WriteResult =
  | { outcome: "written"; sha256: string }
  | { outcome: "conflict"; currentSha256: string | null };

export class SshError extends Error {}

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function parseSshConfigHosts(text: string): string[] {
  const hosts = new Set<string>();
  for (const raw of text.split("\n")) {
    const match = /^\s*Host\s+(.+)$/i.exec(raw.replace(/#.*$/, ""));
    if (match === null) continue;
    for (const name of match[1].trim().split(/\s+/)) {
      if (/^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/.test(name)) hosts.add(name);
    }
  }
  return [...hosts];
}

export async function listConfiguredHosts(): Promise<string[]> {
  try {
    return parseSshConfigHosts(
      await readFile(join(homedir(), ".ssh", "config"), "utf8"),
    );
  } catch {
    return [];
  }
}

export function parseFindOutput(stdout: Buffer): {
  path: string;
  entries: Entry[];
  truncated: boolean;
} {
  const newline = stdout.indexOf(0x0a);
  if (newline === -1) throw new SshError("Сервер вернул неожиданный ответ");
  const path = stdout.subarray(0, newline).toString("utf8");
  const records = stdout.subarray(newline + 1).toString("utf8").split("\0");
  const entries: Entry[] = [];
  for (const record of records) {
    const parts = record.split("\t");
    if (parts.length < 5) continue;
    const [type, targetType, size, mtime] = parts;
    const name = parts.slice(4).join("\t");
    if (name === "") continue;
    const resolved = type === "l" ? targetType : type;
    entries.push({
      name,
      kind: resolved === "d" ? "dir" : resolved === "f" ? "file" : "other",
      link: type === "l",
      size: Number(size) || 0,
      mtimeMs: Math.round(Number(mtime) * 1000) || 0,
    });
  }
  entries.sort((a, b) =>
    a.kind === "dir" && b.kind !== "dir"
      ? -1
      : b.kind === "dir" && a.kind !== "dir"
        ? 1
        : a.name.localeCompare(b.name),
  );
  const truncated = entries.length > MAX_LIST_ENTRIES;
  return { path, entries: entries.slice(0, MAX_LIST_ENTRIES), truncated };
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function looksBinary(data: Buffer): boolean {
  return data.subarray(0, 8192).includes(0);
}

async function runSsh(
  host: string,
  script: string,
  options: { stdin?: string | Buffer; maxBytes: number; timeoutMs: number },
): Promise<Buffer> {
  const hosts = await listConfiguredHosts();
  if (!hosts.includes(host)) {
    throw new SshError(`Хоста «${host}» нет в ~/.ssh/config`);
  }
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${join(homedir(), ".ssh", "bb-ssh-%C")}`,
    "-o", "ControlPersist=300",
    host,
    script,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let failure: SshError | null = null;
    const timer = setTimeout(() => {
      failure = new SshError("Сервер не ответил вовремя");
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        failure = new SshError("Ответ сервера слишком большой");
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new SshError(`Не удалось запустить ssh: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure !== null) return reject(failure);
      if (code !== 0) {
        return reject(
          new SshError(stderr.trim().slice(-500) || `ssh завершился с кодом ${code}`),
        );
      }
      resolve(Buffer.concat(chunks));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");
  });
}

export async function listDir(host: string, path: string) {
  const cd = path === "" ? "cd" : `cd -- ${shQuote(path)}`;
  const stdout = await runSsh(
    host,
    `${cd} && pwd && find . -mindepth 1 -maxdepth 1 -printf '%y\\t%Y\\t%s\\t%T@\\t%P\\0'`,
    { maxBytes: MAX_LIST_BYTES, timeoutMs: 20_000 },
  );
  return parseFindOutput(stdout);
}

export async function readRemoteFile(host: string, path: string): Promise<ReadResult> {
  const f = shQuote(path);
  const data = await runSsh(
    host,
    `[ -f ${f} ] || { echo 'Это не обычный файл' >&2; exit 3; }; head -c ${MAX_FILE_BYTES + 1} -- ${f}`,
    { maxBytes: MAX_FILE_BYTES + 1, timeoutMs: 30_000 },
  ).catch((error: unknown) => {
    if (error instanceof SshError && error.message === "Ответ сервера слишком большой") {
      throw new SshError("Файл больше 5 МБ, открыть нельзя");
    }
    throw error;
  });
  if (data.length > MAX_FILE_BYTES) throw new SshError("Файл больше 5 МБ, открыть нельзя");
  if (looksBinary(data)) return { kind: "binary", sha256: sha256(data), size: data.length };
  return { kind: "text", content: data.toString("utf8"), sha256: sha256(data), size: data.length };
}

export async function writeRemoteFile(
  host: string,
  path: string,
  content: string | Buffer,
  expectedSha256: string,
  maxBytes: number = MAX_FILE_BYTES,
): Promise<WriteResult> {
  if (Buffer.byteLength(content) > maxBytes) {
    throw new SshError(`Содержимое больше ${Math.round(maxBytes / 1024 / 1024)} МБ`);
  }
  const result = await runIfUnchanged(host, path, expectedSha256, (f) => `cat > ${f}`, content);
  return result.outcome === "done" ? { outcome: "written", sha256: sha256(content) } : result;
}

export async function downloadRemoteFile(host: string, path: string): Promise<Buffer> {
  const f = shQuote(path);
  const tooBig = `Файл больше ${MAX_TRANSFER_BYTES / 1024 / 1024} МБ, скачать нельзя`;
  const data = await runSsh(
    host,
    `[ -f ${f} ] || { echo 'Это не обычный файл' >&2; exit 3; }; head -c ${MAX_TRANSFER_BYTES + 1} -- ${f}`,
    { maxBytes: MAX_TRANSFER_BYTES + 1, timeoutMs: TRANSFER_TIMEOUT_MS },
  ).catch((error: unknown) => {
    if (error instanceof SshError && error.message === "Ответ сервера слишком большой") throw new SshError(tooBig);
    throw error;
  });
  if (data.length > MAX_TRANSFER_BYTES) throw new SshError(tooBig);
  return data;
}

export async function putRemoteFile(
  host: string,
  path: string,
  data: Buffer,
  overwrite: boolean,
): Promise<{ outcome: "written" } | { outcome: "exists" }> {
  if (data.length > MAX_TRANSFER_BYTES) {
    throw new SshError(`Файл больше ${MAX_TRANSFER_BYTES / 1024 / 1024} МБ`);
  }
  const f = shQuote(path);
  const script = overwrite
    ? `{ [ ! -e ${f} ] || [ -f ${f} ]; } || { echo 'Это не обычный файл' >&2; exit 3; }; cat > ${f} && echo done`
    : `[ -e ${f} ] && { echo exists; exit 0; }; set -C; cat > ${f} && echo done`;
  const stdout = (await runSsh(host, script, {
    stdin: data,
    maxBytes: 4096,
    timeoutMs: TRANSFER_TIMEOUT_MS,
  })).toString("utf8").trim();
  if (stdout === "done") return { outcome: "written" };
  if (stdout === "exists") return { outcome: "exists" };
  throw new SshError(`Неожиданный ответ сервера: ${stdout.slice(0, 200)}`);
}

async function runSimple(host: string, script: string): Promise<string> {
  return (await runSsh(host, script, { maxBytes: 4096, timeoutMs: 30_000 })).toString("utf8").trim();
}

export async function makeRemoteDir(host: string, path: string): Promise<{ outcome: "created" | "exists" }> {
  const d = shQuote(path);
  const stdout = await runSimple(host, `[ -e ${d} ] && { echo exists; exit 0; }; mkdir -- ${d} && echo done`);
  if (stdout === "done") return { outcome: "created" };
  if (stdout === "exists") return { outcome: "exists" };
  throw new SshError(`Неожиданный ответ сервера: ${stdout.slice(0, 200)}`);
}

export async function renameRemote(
  host: string,
  from: string,
  to: string,
): Promise<{ outcome: "renamed" | "exists" | "missing" | "nodir" }> {
  const a = shQuote(from);
  const b = shQuote(to);
  const targetDir = shQuote(to.slice(0, to.lastIndexOf("/")) || "/");
  const stdout = await runSimple(
    host,
    [
      `[ -e ${a} ] || [ -L ${a} ] || { echo missing; exit 0; }`,
      `[ -d ${targetDir} ] || { echo nodir; exit 0; }`,
      `[ -e ${b} ] || [ -L ${b} ] && { echo exists; exit 0; }`,
      `mv -- ${a} ${b} && echo done`,
    ].join("\n"),
  );
  if (stdout === "done") return { outcome: "renamed" };
  if (stdout === "exists" || stdout === "missing" || stdout === "nodir") return { outcome: stdout };
  throw new SshError(`Неожиданный ответ сервера: ${stdout.slice(0, 200)}`);
}

export const MAX_HASHED_BYTES = 2 * 1024 * 1024;

export function parseShaSums(stdout: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *]\.\/(.+)$/.exec(line);
    if (match !== null) sums.set(match[2], match[1]);
  }
  return sums;
}

export async function remoteDirHashes(host: string, dir: string): Promise<Map<string, string>> {
  const d = shQuote(dir);
  const stdout = await runSsh(
    host,
    `cd -- ${d} && find . -mindepth 1 -maxdepth 1 -type f -size -${MAX_HASHED_BYTES / 1024 + 1}k ! -name '*\n*' ! -name '*\\\\*' -print0 | xargs -0 -r sha256sum --`,
    { maxBytes: MAX_LIST_BYTES, timeoutMs: 60_000 },
  );
  return parseShaSums(stdout.toString("utf8"));
}

export const SCAN_EXCLUDED_DIRS = [
  ".git",
  "node_modules",
  "vendor",
  "storage",
  ".idea",
  ".vscode",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
];

export async function remoteTreeHashes(host: string, dir: string): Promise<Map<string, string>> {
  const d = shQuote(dir);
  const prune = SCAN_EXCLUDED_DIRS.map((name) => `-name ${shQuote(name)}`).join(" -o ");
  const stdout = await runSsh(
    host,
    `cd -- ${d} && find . -mindepth 1 -type d \\( ${prune} \\) -prune -o -type f -size -${MAX_HASHED_BYTES / 1024 + 1}k ! -name '*\n*' ! -name '*\\\\*' -print0 | xargs -0 -r sha256sum --`,
    { maxBytes: 16 * 1024 * 1024, timeoutMs: 90_000 },
  );
  return parseShaSums(stdout.toString("utf8"));
}

const MAX_COUNTED_ENTRIES = 100_000;

function assertDeepEnough(path: string) {
  const segments = path.split("/").filter(Boolean);
  if (segments.includes(".") || segments.includes("..")) {
    throw new SshError("Путь с «.» или «..» удалять не буду");
  }
  if (segments.length < 2) {
    throw new SshError(`«${path}» слишком близко к корню сервера, удалять не буду`);
  }
}

export async function countDirEntries(host: string, path: string): Promise<{ entries: number; capped: boolean }> {
  assertDeepEnough(path);
  const d = shQuote(path);
  const stdout = await runSimple(
    host,
    `[ -d ${d} ] || { echo 'Это не папка' >&2; exit 3; }; find ${d} -mindepth 1 2>/dev/null | head -n ${MAX_COUNTED_ENTRIES} | wc -l`,
  );
  const entries = Number(stdout);
  if (!Number.isFinite(entries)) throw new SshError(`Неожиданный ответ сервера: ${stdout.slice(0, 200)}`);
  return { entries, capped: entries >= MAX_COUNTED_ENTRIES };
}

export async function deleteRemoteDir(host: string, path: string): Promise<{ outcome: "deleted" | "missing" }> {
  assertDeepEnough(path);
  const d = shQuote(path);
  const stdout = (await runSsh(host, `[ -d ${d} ] || { echo missing; exit 0; }; rm -rf -- ${d} && echo done`, {
    maxBytes: 4096,
    timeoutMs: TRANSFER_TIMEOUT_MS,
  })).toString("utf8").trim();
  if (stdout === "done") return { outcome: "deleted" };
  if (stdout === "missing") return { outcome: "missing" };
  throw new SshError(`Неожиданный ответ сервера: ${stdout.slice(0, 200)}`);
}

export async function deleteRemoteFile(
  host: string,
  path: string,
  expectedSha256: string,
): Promise<DeleteResult> {
  const result = await runIfUnchanged(host, path, expectedSha256, (f) => `rm -f -- ${f}`);
  return result.outcome === "done" ? { outcome: "deleted" } : result;
}

async function runIfUnchanged(
  host: string,
  path: string,
  expectedSha256: string,
  command: (quotedPath: string) => string,
  stdin?: string | Buffer,
): Promise<{ outcome: "done" } | { outcome: "conflict"; currentSha256: string | null }> {
  const f = shQuote(path);
  const script = [
    `[ -f ${f} ] || { echo 'conflict:none'; exit 0; }`,
    `cur=$(sha256sum < ${f} | cut -d' ' -f1)`,
    `[ "$cur" = ${shQuote(expectedSha256)} ] || { echo "conflict:$cur"; exit 0; }`,
    `${command(f)} && echo done`,
  ].join("\n");
  const stdout = (await runSsh(host, script, {
    stdin,
    maxBytes: 4096,
    timeoutMs: TRANSFER_TIMEOUT_MS,
  })).toString("utf8").trim();
  if (stdout === "done") return { outcome: "done" };
  const conflict = /^conflict:(\S+)$/.exec(stdout);
  if (conflict !== null) {
    return { outcome: "conflict", currentSha256: conflict[1] === "none" ? null : conflict[1] };
  }
  throw new SshError(`Неожиданный ответ сервера: ${stdout.slice(0, 200)}`);
}

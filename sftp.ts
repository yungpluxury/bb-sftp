import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export type SftpTarget = {
  id: string;
  hostName: string;
  port: number;
  user: string | null;
  keyPath: string | null;
  remotePath: string;
  local: string;
  passphrase: string | null;
  password: string | null;
};

type RawConfig = {
  name?: unknown;
  host?: unknown;
  port?: unknown;
  username?: unknown;
  privateKeyPath?: unknown;
  passphrase?: unknown;
  password?: unknown;
  remotePath?: unknown;
  context?: unknown;
  protocol?: unknown;
  profiles?: unknown;
};

export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
    } else {
      out += char;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const SAFE_TOKEN = /^[A-Za-z0-9_.@:[\]%-]+$/;

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function toTarget(config: RawConfig, workspace: string, id: string): SftpTarget | null {
  const protocol = asText(config.protocol) ?? "sftp";
  const hostName = asText(config.host);
  const remotePath = asText(config.remotePath);
  if (protocol !== "sftp" || hostName === null || remotePath === null || !remotePath.startsWith("/")) return null;
  if (!SAFE_TOKEN.test(hostName) || hostName.startsWith("-")) return null;
  const user = asText(config.username);
  if (user !== null && (!SAFE_TOKEN.test(user) || user.startsWith("-"))) return null;
  const port = config.port === undefined ? 22 : Number(config.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const root = resolve(workspace);
  const context = asText(config.context);
  const local = context === null ? root : resolve(root, context);
  if (local !== root && !local.startsWith(root + sep)) return null;
  const key = asText(config.privateKeyPath);
  return {
    id,
    hostName,
    port,
    user,
    keyPath: key === null ? null : resolve(root, expandHome(key)),
    remotePath: remotePath.replace(/\/+$/, "") || "/",
    local,
    passphrase: typeof config.passphrase === "string" && config.passphrase !== "" ? config.passphrase : null,
    password: typeof config.password === "string" && config.password !== "" ? config.password : null,
  };
}

export const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *[Pp]assphrase*) [ -n "$BB_SSH_PASSPHRASE" ] && printf '%s\\n' "$BB_SSH_PASSPHRASE" && exit 0 ;;
  *[Pp]assword*) [ -n "$BB_SSH_PASSWORD" ] && printf '%s\\n' "$BB_SSH_PASSWORD" && exit 0 ;;
esac
exit 1
`;

export function askpassEnv(target: SftpTarget, scriptPath: string): Record<string, string> | null {
  if (target.passphrase === null && target.password === null) return null;
  return {
    SSH_ASKPASS: scriptPath,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: process.env.DISPLAY ?? "bb-ssh",
    BB_SSH_PASSPHRASE: target.passphrase ?? "",
    BB_SSH_PASSWORD: target.password ?? "",
  };
}

export function parseSftpConfig(text: string, workspace: string): SftpTarget[] {
  const parsed: unknown = JSON.parse(stripJsonComments(text));
  const configs = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (item): item is RawConfig => typeof item === "object" && item !== null,
  );
  const targets: SftpTarget[] = [];
  for (const config of configs) {
    const name = asText(config.name) ?? asText(config.host) ?? "sftp";
    const base = toTarget(config, workspace, `sftp:${name}`);
    if (base !== null) targets.push(base);
    if (typeof config.profiles === "object" && config.profiles !== null) {
      for (const [profile, overrides] of Object.entries(config.profiles)) {
        if (typeof overrides !== "object" || overrides === null) continue;
        const target = toTarget({ ...config, ...(overrides as RawConfig) }, workspace, `sftp:${name}/${profile}`);
        if (target !== null) targets.push(target);
      }
    }
  }
  return targets;
}

export function sshDestinationArgs(target: SftpTarget): string[] {
  return [
    "-p", String(target.port),
    ...(target.user === null ? [] : ["-l", target.user]),
    ...(target.keyPath === null ? [] : ["-i", target.keyPath]),
    target.hostName,
  ];
}

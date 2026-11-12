import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ASKPASS_SCRIPT, askpassEnv, parseSftpConfig, sshDestinationArgs, stripJsonComments } from "./sftp.ts";

test("stripJsonComments drops comments and trailing commas but keeps strings intact", () => {
  const text = `{
    // line comment
    "url": "http://x//y", /* block */
    "a": "quote \\" // not a comment",
  }`;
  assert.deepEqual(JSON.parse(stripJsonComments(text)), { url: "http://x//y", a: 'quote " // not a comment' });
});

test("askpass script answers only ssh's own key and password prompts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bb-ssh-askpass-"));
  const script = join(dir, "askpass.sh");
  await writeFile(script, ASKPASS_SCRIPT, { mode: 0o700 });
  const env = {
    ...process.env,
    BB_SSH_KEY: "/Users/me/.ssh/id_rsa",
    BB_SSH_PASSPHRASE: "pass phrase $x 'q'",
    BB_SSH_PASSWORD_PROMPT: "root@203.0.113.10's password:",
    BB_SSH_PASSWORD: "pw",
  };
  const ask = (prompt: string, extra: Record<string, string> = {}) => {
    try {
      return execFileSync(script, [prompt], { env: { ...env, ...extra } }).toString();
    } catch {
      return null;
    }
  };
  assert.equal(ask("Enter passphrase for key '/Users/me/.ssh/id_rsa': "), "pass phrase $x 'q'\n");
  assert.equal(ask("root@203.0.113.10's password: "), "pw\n");
  assert.equal(ask("Enter passphrase for key '/Users/me/.ssh/other': "), null);
  assert.equal(ask("Passphrase: "), null);
  assert.equal(ask("Password: "), null);
  assert.equal(ask("admin@evil.example's password: "), null);
  assert.equal(ask("Are you sure you want to continue connecting (yes/no/[fingerprint])? "), null);
  assert.equal(ask("root@203.0.113.10's password: ", { BB_SSH_PASSWORD: "" }), null);
  assert.equal(ask("Enter passphrase for key '': ", { BB_SSH_KEY: "" }), null);
});

test("askpassEnv passes only the secrets a target can use", () => {
  const [withPassword] = parseSftpConfig(
    JSON.stringify({ host: "h.example.com", username: "deploy", remotePath: "/x", password: "pw", passphrase: "no key" }),
    "/p",
  );
  const [without] = parseSftpConfig(JSON.stringify({ host: "h.example.com", remotePath: "/x" }), "/p");
  assert.equal(askpassEnv(without, "/s"), null);
  assert.deepEqual(
    { ...askpassEnv(withPassword, "/s"), DISPLAY: "-" },
    {
      SSH_ASKPASS: "/s",
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: "-",
      BB_SSH_KEY: "",
      BB_SSH_PASSPHRASE: "",
      BB_SSH_PASSWORD_PROMPT: "deploy@h.example.com's password:",
      BB_SSH_PASSWORD: "pw",
    },
  );
  const args = sshDestinationArgs(withPassword);
  assert.ok(!args.includes("pw") && !args.includes("no key"));
  assert.deepEqual(args.slice(0, 4), ["-F", "none", "-o", "PreferredAuthentications=publickey,password"]);
});

test("a profile pointing at another host does not inherit the base secrets", () => {
  const targets = parseSftpConfig(
    JSON.stringify({
      name: "web",
      host: "web.example.com",
      remotePath: "/srv",
      password: "base-secret",
      profiles: { same: { remotePath: "/srv/same" }, other: { host: "other.example.com" }, own: { host: "own.example.com", password: "own" } },
    }),
    "/p",
  );
  assert.deepEqual(
    targets.map((t) => [t.id, t.password]),
    [
      ["sftp:web", "base-secret"],
      ["sftp:web/same", "base-secret"],
      ["sftp:web/other", null],
      ["sftp:web/own", "own"],
    ],
  );
});

test("parseSftpConfig reads a VS Code sftp.json, keeping the passphrase out of ssh args", () => {
  const targets = parseSftpConfig(
    JSON.stringify({
      name: "agents",
      host: "203.0.113.10",
      protocol: "sftp",
      port: 22,
      username: "root",
      remotePath: "/var/www/agents/",
      privateKeyPath: "~/.ssh/id_rsa",
      passphrase: "secret",
      uploadOnSave: false,
    }),
    "/Users/me/project",
  );
  assert.deepEqual(targets, [
    {
      id: "sftp:agents",
      hostName: "203.0.113.10",
      port: 22,
      user: "root",
      keyPath: join(homedir(), ".ssh/id_rsa"),
      remotePath: "/var/www/agents",
      local: "/Users/me/project",
      passphrase: "secret",
      password: null,
    },
  ]);
  assert.deepEqual(sshDestinationArgs(targets[0]), [
    "-F", "none",
    "-o", "PreferredAuthentications=publickey,password",
    "-p", "22", "-l", "root", "-i", join(homedir(), ".ssh/id_rsa"), "203.0.113.10",
  ]);
});

test("parseSftpConfig handles arrays, profiles, context, and rejects unsafe or unsupported entries", () => {
  const targets = parseSftpConfig(
    JSON.stringify([
      { name: "web", host: "web.example.com", remotePath: "/srv/web", context: "public", profiles: { stage: { host: "stage.example.com", remotePath: "/srv/stage" } } },
      { name: "ftp", host: "ftp.example.com", protocol: "ftp", remotePath: "/x" },
      { name: "evil", host: "-oProxyCommand=boom", remotePath: "/x" },
      { name: "escape", host: "ok.example.com", remotePath: "/x", context: "../outside" },
      { name: "relative", host: "ok.example.com", remotePath: "x" },
    ]),
    "/Users/me/project",
  );
  assert.deepEqual(
    targets.map((t) => [t.id, t.hostName, t.remotePath, t.local, t.port]),
    [
      ["sftp:web", "web.example.com", "/srv/web", "/Users/me/project/public", 22],
      ["sftp:web/stage", "stage.example.com", "/srv/stage", "/Users/me/project/public", 22],
    ],
  );
});

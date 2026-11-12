import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { countDirEntries, deleteRemoteDir, parseFindOutput, parseShaSums, parseSshConfigHosts, shQuote } from "./ssh.ts";

test("parseShaSums reads sha256sum lines for ./names, including spaces and binary marks", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const sums = parseShaSums(`${a}  ./app.php\n${b} *./with space.bin\nsha256sum: ./locked: Permission denied\n\n`);
  assert.deepEqual([...sums], [["app.php", a], ["with space.bin", b]]);
});

test("folder deletion refuses paths near the server root before connecting", async () => {
  for (const path of ["/", "/var", "/etc/", "/var/www/..", "/var/./www"]) {
    await assert.rejects(deleteRemoteDir("any-host", path), /корню|«\.»/);
    await assert.rejects(countDirEntries("any-host", path), /корню|«\.»/);
  }
});

test("parseSshConfigHosts keeps plain aliases and skips patterns", () => {
  const config = [
    "Include ~/.orbstack/ssh/config",
    "Host example-test  # test",
    "    HostName 203.0.113.10",
    "host a.example.com b-alias",
    "Host *",
    "Host !bad prod-*",
    "Host -oProxyCommand=evil",
    "  Host indented",
  ].join("\n");
  assert.deepEqual(parseSshConfigHosts(config), [
    "example-test",
    "a.example.com",
    "b-alias",
    "indented",
  ]);
});

test("shQuote survives the shell for hostile names", () => {
  for (const value of ["plain", "it's", "a b", "$(rm -rf /)", "`x`", "\"q\"", "new\nline", "'"]) {
    assert.equal(execFileSync("sh", ["-c", `printf %s ${shQuote(value)}`]).toString(), value);
  }
});

test("parseFindOutput resolves path, symlinks, sorting and odd names", () => {
  const raw =
    "/var/www\n" +
    "f\tf\t12\t1700000000.5\tz.txt\0" +
    "d\td\t4096\t1700000001.0\tsite\0" +
    "l\td\t7\t1700000002.0\tcurrent\0" +
    "l\tN\t7\t1700000003.0\tbroken\0" +
    "f\tf\t1\t1700000004.0\ttab\tname\0" +
    "f\tf\t1\t1700000005.0\tline\nbreak\0";
  const { path, entries, truncated } = parseFindOutput(Buffer.from(raw));
  assert.equal(path, "/var/www");
  assert.equal(truncated, false);
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.kind, entry.link]),
    [
      ["current", "dir", true],
      ["site", "dir", false],
      ["broken", "other", true],
      ["line\nbreak", "file", false],
      ["tab\tname", "file", false],
      ["z.txt", "file", false],
    ],
  );
  assert.equal(entries.find((entry) => entry.name === "z.txt")?.mtimeMs, 1700000000500);
});

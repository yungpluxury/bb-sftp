import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalHasher, findLinkTarget, localPathFor, sha256Hex, summarizeByChild, writeLocal } from "./local.ts";

test("findLinkTarget matches the thread folder to a linked host", () => {
  const links = {
    agents: { local: "/Users/me/dev/agents", remote: "/var/www/agents/" },
    other: { local: "/Users/me/dev/other", remote: "/srv/other" },
  };
  assert.deepEqual(findLinkTarget(links, ["/Users/me/dev/agents"]), { host: "agents", dir: "/var/www/agents" });
  assert.deepEqual(findLinkTarget(links, ["/Users/me/dev/agents/app/Models"]), {
    host: "agents",
    dir: "/var/www/agents/app/Models",
  });
  assert.deepEqual(findLinkTarget(links, ["/Users/me/dev"]), { host: "agents", dir: "/var/www/agents" });
  assert.deepEqual(findLinkTarget(links, ["/Users/me/.bb/worktrees/x", "/Users/me/dev/other"]), {
    host: "other",
    dir: "/srv/other",
  });
  assert.equal(findLinkTarget(links, ["/Users/me/dev/agents-old"]), null);
  assert.equal(findLinkTarget({}, ["/Users/me/dev/agents"]), null);
});

test("summarizeByChild keeps files as is and gives folders their worst state", () => {
  assert.deepEqual(
    summarizeByChild([
      ["a.php", "same"],
      ["b.php", "differs"],
      ["app/x.php", "same"],
      ["app/deep/y.php", "missing"],
      ["config/z.php", "missing"],
      ["config/w.php", "differs"],
      ["config/v.php", "same"],
      ["public/i.txt", "same"],
    ]),
    { "a.php": "same", "b.php": "differs", app: "missing", config: "differs", public: "same" },
  );
});

test("createLocalHasher hashes, reports missing and oversized files, and rehashes after a change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bb-ssh-hash-"));
  const file = join(dir, "a.txt");
  const hash = createLocalHasher(8);
  assert.equal(await hash(file), null);
  await writeFile(file, "one");
  assert.equal(await hash(file), sha256Hex("one"));
  await writeFile(file, "two!");
  assert.equal(await hash(file), sha256Hex("two!"));
  await writeFile(file, "much too long");
  assert.equal(await hash(file), "unreadable");
  assert.equal(await hash(dir), "unreadable");
});

const link = { local: "/Users/me/project", remote: "/var/www/agents" };

test("localPathFor maps files under the remote folder", () => {
  assert.equal(localPathFor(link, "/var/www/agents/app/Models/User.php"), "/Users/me/project/app/Models/User.php");
  assert.equal(localPathFor({ ...link, remote: "/var/www/agents/" }, "/var/www/agents/.env"), "/Users/me/project/.env");
  assert.equal(localPathFor({ local: "~/project", remote: "/srv" }, "/srv/a.txt"), join(homedir(), "project", "a.txt"));
});

test("localPathFor refuses paths outside the link or escaping it", () => {
  for (const remote of [
    "/var/www/agents",
    "/var/www/agents-old/x.php",
    "/var/www/other.php",
    "/var/www/agents/../../etc/passwd",
    "/var/www/agents/./a",
    "/var/www/agents//a",
  ]) {
    assert.equal(localPathFor(link, remote), null, remote);
  }
});

test("writeLocal creates folders, then refuses to clobber an unexpected version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bb-ssh-local-"));
  const file = join(dir, "nested", "a.txt");
  assert.equal(await writeLocal(file, Buffer.from("one"), null, 1024), "written");
  assert.equal(await readFile(file, "utf8"), "one");
  assert.equal(await writeLocal(file, Buffer.from("two"), null, 1024), "conflict");
  await writeFile(file, "changed elsewhere");
  assert.equal(await writeLocal(file, Buffer.from("two"), sha256Hex("one"), 1024), "conflict");
  assert.equal(await writeLocal(file, Buffer.from("two"), sha256Hex("changed elsewhere"), 1024), "written");
  assert.equal(await readFile(file, "utf8"), "two");
});

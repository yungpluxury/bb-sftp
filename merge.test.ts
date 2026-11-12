import assert from "node:assert/strict";
import { test } from "node:test";
import { hasConflictMarkers, mergeThreeWay } from "./merge.ts";

const base = ["<?php", "", "function a() {}", "", "function b() {}", "", "function c() {}", ""].join("\n");

test("non-overlapping edits merge cleanly", () => {
  const mine = base.replace("function a() {}", "function a() { return 1; }");
  const theirs = base.replace("function c() {}", "function c() { return 3; }");
  const result = mergeThreeWay(base, mine, theirs);
  assert.equal(result.conflicts, 0);
  assert.equal(
    result.text,
    base.replace("function a() {}", "function a() { return 1; }").replace("function c() {}", "function c() { return 3; }"),
  );
  assert.equal(hasConflictMarkers(result.text), false);
});

test("same line edited on both sides becomes a marked conflict", () => {
  const mine = base.replace("function b() {}", "function b() { return 'mine'; }");
  const theirs = base.replace("function b() {}", "function b() { return 'server'; }");
  const result = mergeThreeWay(base, mine, theirs);
  assert.equal(result.conflicts, 1);
  assert.match(
    result.text,
    /<<<<<<< ваши правки\nfunction b\(\) \{ return 'mine'; \}\n=======\nfunction b\(\) \{ return 'server'; \}\n>>>>>>> сервер/,
  );
  assert.equal(hasConflictMarkers(result.text), true);
});

test("identical edits on both sides are not a conflict", () => {
  const changed = base.replace("function b() {}", "function b() { return 2; }");
  const result = mergeThreeWay(base, changed, changed);
  assert.equal(result.conflicts, 0);
  assert.equal(result.text, changed);
});

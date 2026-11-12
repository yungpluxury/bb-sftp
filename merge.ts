import { diff3Merge } from "node-diff3";

export const MINE_MARK = "<<<<<<< ваши правки";
export const SPLIT_MARK = "=======";
export const THEIRS_MARK = ">>>>>>> сервер";

export function mergeThreeWay(
  base: string,
  mine: string,
  theirs: string,
): { text: string; conflicts: number } {
  const regions = diff3Merge(mine.split("\n"), base.split("\n"), theirs.split("\n"));
  const lines: string[] = [];
  let conflicts = 0;
  for (const region of regions) {
    if (region.ok !== undefined) {
      lines.push(...region.ok);
    } else if (region.conflict !== undefined) {
      conflicts += 1;
      lines.push(MINE_MARK, ...region.conflict.a, SPLIT_MARK, ...region.conflict.b, THEIRS_MARK);
    }
  }
  return { text: lines.join("\n"), conflicts };
}

export function hasConflictMarkers(text: string): boolean {
  const lines = text.split("\n");
  return lines.includes(MINE_MARK) || lines.includes(THEIRS_MARK);
}

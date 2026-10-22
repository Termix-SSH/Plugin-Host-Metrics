import { describe, expect, it } from "vitest";
import { packGrid } from "../../src/frontend/grid-packing";

describe("drop-preview packing", () => {
  it("fills earlier holes like a row-dense grid, including unequal cards", () => {
    expect(
      packGrid(
        [
          { width: 6, height: 8 },
          { width: 4, height: 3 },
          { width: 4, height: 2 },
        ],
        10,
      ),
    ).toEqual([
      { x: 0, y: 0, width: 6, height: 8 },
      { x: 6, y: 0, width: 4, height: 3 },
      { x: 6, y: 3, width: 4, height: 2 },
    ]);
  });

  it("matches a cell-by-cell dense placement without scanning pixel-sized tracks", () => {
    let seed = 17;
    const random = (max: number) =>
      ((seed = (seed * 16807) % 2147483647) % max) + 1;
    for (let run = 0; run < 100; run++) {
      const cells = Array.from({ length: 12 }, () => ({
        width: random(8),
        height: random(6),
      }));
      const expected: {
        x: number;
        y: number;
        width: number;
        height: number;
      }[] = [];
      for (const cell of cells) {
        find: for (let y = 0; ; y++) {
          for (let x = 0; x + cell.width <= 8; x++) {
            if (
              expected.some(
                (r) =>
                  x < r.x + r.width &&
                  x + cell.width > r.x &&
                  y < r.y + r.height &&
                  y + cell.height > r.y,
              )
            )
              continue;
            expected.push({ ...cell, x, y });
            break find;
          }
        }
      }
      expect(packGrid(cells, 8)).toEqual(expected);
    }
  });

  it("handles maximum saved pixel dimensions without changing the input", () => {
    const cells = Array.from({ length: 40 }, () => ({
      width: 8192,
      height: 10012,
    }));
    expect(packGrid(cells, 8192).at(-1)).toEqual({
      x: 0,
      y: 39 * 10012,
      width: 8192,
      height: 10012,
    });
    expect(cells[0]).toEqual({ width: 8192, height: 10012 });
  });
});

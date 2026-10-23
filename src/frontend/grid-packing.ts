interface Cell {
  width: number;
  height: number;
}

/** Match CSS grid's row-dense placement without moving live React/SDK nodes. */
export function packGrid(cells: Cell[], columns: number) {
  const placed: (Cell & { x: number; y: number })[] = [];
  for (const cell of cells) {
    const width = Math.min(columns, Math.max(1, cell.width));
    const ys = [...new Set([0, ...placed.map((r) => r.y + r.height)])].sort(
      (a, b) => a - b,
    );
    const xs = [...new Set([0, ...placed.map((r) => r.x + r.width)])].sort(
      (a, b) => a - b,
    );
    find: for (const y of ys) {
      for (const x of xs) {
        if (x + width > columns) continue;
        if (
          placed.some(
            (r) =>
              x < r.x + r.width &&
              x + width > r.x &&
              y < r.y + r.height &&
              y + cell.height > r.y,
          )
        )
          continue;
        placed.push({ x, y, width, height: cell.height });
        break find;
      }
    }
  }
  return placed;
}

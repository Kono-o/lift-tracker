<script lang="ts">
  let { userId, size = 32, className = '', rounded = 8, seed } = $props<{
    userId: string;
    size?: number;
    className?: string;
    rounded?: number;
    seed?: string; // temporary: influences identicon along with userId
  }>();

  const borderRadius = $derived(`${(rounded / 100) * size}px`);

  function hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  const effectiveId = $derived(seed ? `${userId}:${seed}` : userId);
  const hash = $derived(hashCode(effectiveId));

  const GRID_SIZE = 5;
  const cellSize = 100 / GRID_SIZE;

  // Compute everything in one derived so the template updates reliably when seed changes
  const avatarData = $derived.by(() => {
    const h = hash;
    const hue = h % 360;
    const complement = (hue + 180) % 360;

    const colors = {
      bg: `hsl(${hue}, 22%, 14%)`,
      cubeA: `hsl(${hue}, 68%, 62%)`,
      cubeB: `hsl(${complement}, 68%, 62%)`,
    };

    // left-right symmetric 5x5 grid
    const g: boolean[][] = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      const row: boolean[] = [];
      for (let x = 0; x < Math.ceil(GRID_SIZE / 2); x++) {
        const bitPos = (y * 5 + x * 2) % 31;
        const on = ((h >> bitPos) & 1) === 1;
        row.push(on);
      }
      const mirrored = [...row];
      const start = GRID_SIZE % 2 === 0 ? row.length - 1 : row.length - 2;
      for (let x = start; x >= 0; x--) {
        mirrored.push(row[x]);
      }
      g.push(mirrored);
    }

    // precompute the fills for each cell (using symmetric bit for color)
    const cells: { x: number; y: number; fill: string }[] = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (g[y][x]) {
          const symX = Math.min(x, GRID_SIZE - 1 - x);
          const bit = (h >> ((y * GRID_SIZE + symX) % 31)) & 1;
          const fill = bit ? colors.cubeA : colors.cubeB;
          cells.push({ x, y, fill });
        }
      }
    }

    return { colors, cells };
  });
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 100 100"
  class={`generated-avatar overflow-hidden ${className}`}
  style={`border-radius: ${borderRadius};`}
  aria-hidden="true"
>
  <!-- Background cube -->
  <rect x="0" y="0" width="100" height="100" fill={avatarData.colors.bg} rx={rounded} />

  <!-- Unique pattern (symmetric permutation based on user ID + seed) as nested inner cubes -->
  {#each avatarData.cells as cell (cell.x + '-' + cell.y)}
    <rect
      x={cell.x * cellSize + 2}
      y={cell.y * cellSize + 2}
      width={cellSize - 4}
      height={cellSize - 4}
      fill={cell.fill}
      rx="2"
    />
  {/each}
</svg>

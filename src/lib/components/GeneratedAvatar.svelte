<script lang="ts">
  let { userId, size = 32, className = '', rounded = 8 } = $props<{
    userId: string;
    size?: number;
    className?: string;
    rounded?: number;
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

  const hash = $derived(hashCode(userId));

  const GRID_SIZE = 5;
  const cellSize = 100 / GRID_SIZE;

  // Per-user hue from hash; second cube color is its HSL complement (+180°)
  const avatarColors = $derived.by(() => {
    const hue = hash % 360;
    const complement = (hue + 180) % 360;
    return {
      bg: `hsl(${hue}, 22%, 14%)`,
      cubeA: `hsl(${hue}, 68%, 62%)`,
      cubeB: `hsl(${complement}, 68%, 62%)`,
    };
  });

  function cubeFill(x: number, y: number): string {
    const symX = Math.min(x, GRID_SIZE - 1 - x);
    const bit = (hash >> ((y * GRID_SIZE + symX) % 31)) & 1;
    return bit ? avatarColors.cubeA : avatarColors.cubeB;
  }

  // Generate left-right symmetric 5x5 grid
  const grid = $derived.by(() => {
    const g: boolean[][] = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      const row: boolean[] = [];
      for (let x = 0; x < Math.ceil(GRID_SIZE / 2); x++) {
        const bitPos = (y * 5 + x * 2) % 31;
        const on = ((hash >> bitPos) & 1) === 1;
        row.push(on);
      }
      const mirrored = [...row];
      const start = GRID_SIZE % 2 === 0 ? row.length - 1 : row.length - 2;
      for (let x = start; x >= 0; x--) {
        mirrored.push(row[x]);
      }
      g.push(mirrored);
    }
    return g;
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
  <rect x="0" y="0" width="100" height="100" fill={avatarColors.bg} rx={rounded} />

  <!-- Unique pattern (symmetric permutation based on user ID) as nested inner cubes -->
  {#each grid as row, y}
    {#each row as filled, x}
      {#if filled}
        <rect
          x={x * cellSize + 2}
          y={y * cellSize + 2}
          width={cellSize - 4}
          height={cellSize - 4}
          fill={cubeFill(x, y)}
          rx="2"
        />
      {/if}
    {/each}
  {/each}
</svg>

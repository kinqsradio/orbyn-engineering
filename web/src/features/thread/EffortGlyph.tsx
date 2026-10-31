const HEIGHT = 14;
const STEP = 4;
const BAR = 2;
const INSET = 2;

/** Rising bars on whole pixels, filled up to the level, in the text colour. */
export function EffortGlyph({ count, filled }: { count: number; filled: number }) {
  const width = STEP * count - (STEP - BAR);
  const tallest = HEIGHT - INSET;
  const rise = Math.max(1, Math.round(tallest / 2 / Math.max(count - 1, 1)));
  return (
    <svg className="effort-glyph" width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} aria-hidden>
      {Array.from({ length: count }, (_, index) => {
        const bar = tallest - (count - 1 - index) * rise;
        return (
          <rect
            key={index}
            x={index * STEP}
            y={HEIGHT - INSET - bar}
            width={BAR}
            height={bar}
            rx={1}
            opacity={index < filled ? 1 : 0.3}
          />
        );
      })}
    </svg>
  );
}

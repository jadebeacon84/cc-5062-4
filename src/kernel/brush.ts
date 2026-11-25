import { Rect } from './geometry';

export type RGBA = readonly [number, number, number, number];

export interface BrushStyle {
  color: RGBA;
  /** Radius of the round stamp in canvas pixels. */
  radius: number;
  opacity: number;
  /** 0 = hard edge, 1 = fully soft. */
  hardness: number;
  /**
   * 'paint' uses `color` as-is. 'smudge' picks its ink color from the
   * committed canvas under the stroke's first point before any tile is
   * modified; on blank canvas it picks up no ink and the stroke is a no-op.
   */
  mode?: 'paint' | 'smudge';
}

export const DEFAULT_BRUSH: BrushStyle = {
  color: [28, 30, 38, 255],
  radius: 6,
  opacity: 1,
  hardness: 0.65,
};

/**
 * Analytic coverage of a round brush edge at a pixel center. This is the single
 * definition of brush coverage shared by every rasterizer and by the reference
 * monolithic implementation used in tests, which is what makes tiled output and
 * single-canvas output agree exactly.
 */
export function brushCoverage(dist: number, radius: number, hardness: number): number {
  const edge = dist - (radius - 0.5);
  let a = edge <= -1 ? 1 : edge >= 0.5 ? 0 : (0.5 - edge) / 1.5;
  if (a <= 0) return 0;
  if (hardness < 1 && radius > 0.5) {
    const soft = 1 - hardness;
    const falloff = Math.min(1, Math.max(0, (radius - dist) / (radius * soft + 1e-6)));
    a *= falloff;
  }
  return Math.min(1, a);
}

export function clampRectTo(r: Rect, w: number, h: number): Rect {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(w, r.x + r.w);
  const y1 = Math.min(h, r.y + r.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

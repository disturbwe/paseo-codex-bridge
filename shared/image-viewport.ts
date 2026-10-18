export type Point = { x: number; y: number };
export type Dimensions = { width: number; height: number };
export function fitScale(image: Dimensions, viewport: Dimensions) {
  return Math.min(1, viewport.width / image.width, viewport.height / image.height);
}
export function clampScale(scale: number, fit: number) {
  return Math.max(Math.min(0.1, fit), Math.min(8, scale));
}
export function clampPan(offset: Point, image: Dimensions, viewport: Dimensions, scale: number): Point {
  const x = Math.max(0, (image.width * scale - viewport.width) / 2);
  const y = Math.max(0, (image.height * scale - viewport.height) / 2);
  return { x: x === 0 ? 0 : Math.max(-x, Math.min(x, offset.x)), y: y === 0 ? 0 : Math.max(-y, Math.min(y, offset.y)) };
}
export function zoomAt(offset: Point, previous: number, next: number, anchor: Point, image: Dimensions, viewport: Dimensions) {
  return clampPan({ x: anchor.x - (anchor.x - offset.x) * next / previous, y: anchor.y - (anchor.y - offset.y) * next / previous }, image, viewport, next);
}

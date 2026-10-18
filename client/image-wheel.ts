import { useEffect, useRef, type RefObject } from "react";
import { Platform, type View } from "react-native";
import type { Point } from "../shared/image-viewport";

type Wheel = { deltaY: number; deltaMode: number; clientX: number; clientY: number; preventDefault(): void };
type WebView = { addEventListener(type: string, handler: (event: Wheel) => void, options: { passive: boolean }): void; removeEventListener(type: string, handler: (event: Wheel) => void): void; getBoundingClientRect(): { left: number; top: number; width: number; height: number } };
// Desktop-only adapter. Listen on the image canvas, never the entire app.
// The viewer itself uses React Native responders on every platform.
export function useImageWheel(ref: RefObject<View | null>, onZoom: (factor: number, anchor: Point) => void) {
  const callback = useRef(onZoom); callback.current = onZoom;
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = ref.current as unknown as WebView | null;
    if (!node?.addEventListener) return;
    const handler = (event: Wheel) => {
      event.preventDefault();
      const bounds = node.getBoundingClientRect();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
      callback.current(Math.exp(-Math.max(-400, Math.min(400, pixels)) * 0.002), { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 });
    };
    node.addEventListener("wheel", handler, { passive: false });
    return () => node.removeEventListener("wheel", handler);
  }, [ref]);
}

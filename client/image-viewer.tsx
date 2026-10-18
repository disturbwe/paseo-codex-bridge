import { useMemo, useRef, useState } from "react";
import { Image, Modal, PanResponder, Pressable, Text, View, useWindowDimensions } from "react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { clampPan, clampScale, fitScale, zoomAt, type Dimensions, type Point } from "../shared/image-viewport";
import { useImageWheel } from "./image-wheel";

type Props = Pick<PluginHostProps, "theme" | "layout"> & { filename: string; filePath: string; uri: string; size: Dimensions; onClose(): void };
export function ImageViewer(props: Props) {
  return <Modal visible transparent animationType="fade" onRequestClose={props.onClose} presentationStyle="overFullScreen"><ViewerContent {...props} /></Modal>;
}

function ViewerContent({ filename, filePath, uri, size, theme, layout, onClose }: Props) {
  const viewport = useWindowDimensions(), toast = useToast();
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<{ scale: number | null; offset: Point }>({ scale: null, offset: { x: 0, y: 0 } });
  const canvas = { width: Math.max(160, Math.min(1280, viewport.width - (layout.compact ? 32 : 80))), height: Math.max(120, viewport.height - 224) };
  const fit = fitScale(size, canvas), scale = view.scale ?? fit;
  const offset = clampPan(view.offset, size, canvas, scale);
  const current = useRef({ scale, offset, fit, canvas, size }); current.current = { scale, offset, fit, canvas, size };
  const canvasRef = useRef<View>(null);
  const drag = useRef<Point>({ x: 0, y: 0 });
  const pinch = useRef<{ distance: number; scale: number; offset: Point; anchor: Point } | null>(null);
  const lastPress = useRef(0);
  const changeZoom = (next: number | null, anchor: Point = { x: 0, y: 0 }) => {
    const frame = current.current;
    const target = next === null ? frame.fit : clampScale(next, frame.fit);
    setView({ scale: next === null ? null : target, offset: next === null ? { x: 0, y: 0 } : zoomAt(frame.offset, frame.scale, target, anchor, frame.size, frame.canvas) });
  };
  const zoom = useRef(changeZoom); zoom.current = changeZoom;
  useImageWheel(canvasRef, (factor, anchor) => zoom.current(current.current.scale * factor, anchor));
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: event => event.nativeEvent.touches.length >= 2,
    onMoveShouldSetPanResponder: (event, gesture) => {
      const frame = current.current;
      return event.nativeEvent.touches.length >= 2 || ((Math.abs(gesture.dx) > 3 || Math.abs(gesture.dy) > 3) && (frame.size.width * frame.scale > frame.canvas.width + 1 || frame.size.height * frame.scale > frame.canvas.height + 1));
    },
    onPanResponderGrant: () => { drag.current = current.current.offset; pinch.current = null; },
    onPanResponderMove: (event, gesture) => {
      const frame = current.current, touches = event.nativeEvent.touches;
      if (touches.length >= 2) {
        const [first, second] = touches;
        const distance = Math.hypot(first.pageX - second.pageX, first.pageY - second.pageY);
        if (!pinch.current) pinch.current = { distance: Math.max(1, distance), scale: frame.scale, offset: frame.offset, anchor: { x: (first.locationX + second.locationX) / 2 - frame.canvas.width / 2, y: (first.locationY + second.locationY) / 2 - frame.canvas.height / 2 } };
        const initial = pinch.current, next = clampScale(initial.scale * distance / initial.distance, frame.fit);
        setView({ scale: next, offset: zoomAt(initial.offset, initial.scale, next, initial.anchor, frame.size, frame.canvas) });
      } else {
        if (pinch.current) { pinch.current = null; drag.current = { x: frame.offset.x - gesture.dx, y: frame.offset.y - gesture.dy }; }
        setView(previous => ({ ...previous, offset: clampPan({ x: drag.current.x + gesture.dx, y: drag.current.y + gesture.dy }, frame.size, frame.canvas, frame.scale) }));
      }
    },
    onPanResponderRelease: () => { pinch.current = null; },
    onPanResponderTerminate: () => { pinch.current = null; },
  }), []);
  const button = { padding: 9, borderRadius: 8, backgroundColor: theme.colors.surface1 };
  return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: layout.compact ? 16 : 40 }}>
    <Pressable accessibilityRole="button" accessibilityLabel="关闭图片预览背景" onPress={onClose} style={{ position: "absolute", inset: 0, backgroundColor: theme.colors.surface0, opacity: 0.96 }} />
    <View style={{ width: canvas.width, maxWidth: "100%", gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
          <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{filename}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{size.width} × {size.height}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="复制图片路径" onPress={() => { void copyText(filePath).then(() => setCopied(true)).catch(() => toast.error("无法复制图片路径")); }} style={button}><Icon name={copied ? "Check" : "Copy"} size={17} color={theme.colors.foregroundMuted} /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭图片预览" onPress={onClose} style={button}><Icon name="X" size={19} color={theme.colors.foreground} /></Pressable>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="缩小图片" disabled={scale <= Math.min(0.1, fit)} onPress={() => changeZoom(scale / 1.25)} style={{ ...button, opacity: scale <= Math.min(0.1, fit) ? 0.35 : 1 }}><Icon name="ZoomOut" size={18} color={theme.colors.foreground} /></Pressable>
        <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foreground, fontSize: 13, width: 56, textAlign: "center", fontVariant: ["tabular-nums"] }}>{Math.round(scale * 100)}%</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="放大图片" disabled={scale >= 8} onPress={() => changeZoom(scale * 1.25)} style={{ ...button, opacity: scale >= 8 ? 0.35 : 1 }}><Icon name="ZoomIn" size={18} color={theme.colors.foreground} /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="原始尺寸 100%" onPress={() => changeZoom(1)} style={button}><Text style={{ color: theme.colors.foreground, fontSize: 12 }}>100%</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="适应窗口" accessibilityState={{ selected: view.scale === null }} onPress={() => changeZoom(null)} style={button}><Icon name="Scan" size={18} color={view.scale === null ? theme.colors.accent : theme.colors.foregroundMuted} /></Pressable>
      </View>
      <View ref={canvasRef} {...responder.panHandlers} style={{ width: canvas.width, height: canvas.height, overflow: "hidden", borderRadius: 10, backgroundColor: theme.colors.surface1 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="双击切换适应窗口与原始尺寸" onPress={() => { const now = Date.now(); if (now - lastPress.current < 300) { changeZoom(view.scale === null ? 1 : null); lastPress.current = 0; } else lastPress.current = now; }} style={{ position: "absolute", inset: 0 }}>
          <View pointerEvents="none" style={{position:"absolute",inset:0}}><Image source={{ uri }} resizeMode="contain" style={{ position: "absolute", width: size.width * scale, height: size.height * scale, left: (canvas.width - size.width * scale) / 2 + offset.x, top: (canvas.height - size.height * scale) / 2 + offset.y }} accessibilityLabel={`${filename} 完整图像`} /></View>
        </Pressable>
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, textAlign: "center" }}>{layout.platform === "web" ? "滚轮缩放 · 放大后拖动 · 双击切换原始尺寸 · Esc 关闭" : "双指缩放 · 放大后拖动 · 双击切换原始尺寸"}</Text>
    </View>
  </View>;
}

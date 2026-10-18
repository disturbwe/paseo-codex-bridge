import { useState } from "react";
import { Image, Modal, Pressable, Text, View, useWindowDimensions } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { imagePreview } from "../shared/images";

type Data = { callId: string; filePath: string; status: string };
export function ImageViewRow({ agentId, item, theme, layout }: PluginTimelineItemProps<Data>) {
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState({ width: 1280, height: 720 });
  const [copied, setCopied] = useState(false);
  const viewport = useWindowDimensions();
  const toast = useToast();
  const preview = useRpc(imagePreview);
  const query = useQuery({ queryKey: ["desktop-image", agentId, item.data.callId], queryFn: () => preview({ agentId, callId: item.data.callId }), enabled: expanded, refetchInterval: false, refetchOnWindowFocus: false, retry: false, gcTime: 60000 });
  const label = item.data.status === "running" ? "正在查看 1 张图像" : item.data.status === "failed" ? "查看图像失败" : item.data.status === "canceled" ? "已取消查看图像" : "已查看 1 张图像";
  const filename = item.data.filePath.split(/[\\/]/).pop() || "图像预览";
  const ratio = size.width / size.height;
  const availableWidth = Math.max(160, Math.min(1280, viewport.width - (layout.compact ? 32 : 80)));
  const availableHeight = Math.max(120, viewport.height - 176);
  const imageWidth = Math.min(size.width, availableWidth, availableHeight * ratio);
  const imageHeight = imageWidth / ratio;
  const thumbnailWidth = Math.min(160, 112 * ratio);
  const close = () => setOpen(false);

  return <View style={{ gap: 8, paddingVertical: 6 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={{ flexDirection: "row", alignItems: "center", gap: 7, alignSelf: "flex-start", paddingVertical: 2 }}>
      <Icon name="Images" size={15} color={theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{label}</Text>
      <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={13} color={theme.colors.foregroundMuted} />
    </Pressable>
    {expanded && <View style={{ gap: 6, alignItems: "flex-start" }}>
      {query.isPending && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>正在加载图片…</Text>}
      {query.error && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{String(query.error)}</Text>}
      {query.data && <Pressable accessibilityRole="button" accessibilityLabel={`放大查看 ${filename}`} onPress={() => { setCopied(false); setOpen(true); }} style={({ pressed }) => ({ borderRadius: 9, overflow: "hidden", borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, opacity: pressed ? 0.8 : 1 })}>
        <Image source={{ uri: query.data.uri }} resizeMode="contain" style={{ width: thumbnailWidth, height: thumbnailWidth / ratio }} accessibilityLabel={filename} onLoad={({ nativeEvent }) => {
          const source = nativeEvent.source;
          if (source?.width > 0 && source?.height > 0) setSize(previous => previous.width === source.width && previous.height === source.height ? previous : { width: source.width, height: source.height });
        }} />
      </Pressable>}
      <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: theme.colors.foregroundMuted, fontSize: 11, maxWidth: 220 }}>{filename}</Text>
    </View>}
    <Modal visible={open} transparent animationType="fade" onRequestClose={close} presentationStyle="overFullScreen">
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: layout.compact ? 16 : 40 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭图片预览背景" onPress={close} style={{ position: "absolute", inset: 0, backgroundColor: theme.colors.surface0, opacity: 0.96 }} />
        <View style={{ width: availableWidth, maxWidth: "100%", gap: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
              <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{filename}</Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{size.width} × {size.height}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="复制图片路径" onPress={() => { void copyText(item.data.filePath).then(() => setCopied(true)).catch(() => toast.error("无法复制图片路径")); }} style={{ padding: 9, borderRadius: 8, backgroundColor: theme.colors.surface1 }}>
              <Icon name={copied ? "Check" : "Copy"} size={17} color={theme.colors.foregroundMuted} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭图片预览" onPress={close} style={{ padding: 9, borderRadius: 8, backgroundColor: theme.colors.surface1 }}>
              <Icon name="X" size={19} color={theme.colors.foreground} />
            </Pressable>
          </View>
          <View style={{ alignItems: "center", justifyContent: "center" }}>
            {query.data && <Image source={{ uri: query.data.uri }} resizeMode="contain" style={{ width: imageWidth, height: imageHeight, maxWidth: "100%", borderRadius: 10, backgroundColor: theme.colors.surface1 }} accessibilityLabel={`${filename} 完整图像`} />}
          </View>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, textAlign: "center" }}>{layout.platform === "web" ? "点击空白处或按 Esc 关闭" : "点击空白处关闭"}</Text>
        </View>
      </View>
    </Modal>
  </View>;
}

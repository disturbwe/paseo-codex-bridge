import { useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { ImageViewer } from "./image-viewer";
import { imagePreview } from "../shared/images";

type Data = { callId: string; filePath: string; status: string };
export function ImageViewRow({ agentId, item, theme, layout }: PluginTimelineItemProps<Data>) {
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState({ width: 1280, height: 720 });
  const preview = useRpc(imagePreview);
  const query = useQuery({ queryKey: ["desktop-image", agentId, item.data.callId], queryFn: () => preview({ agentId, callId: item.data.callId }), enabled: expanded, refetchInterval: false, refetchOnWindowFocus: false, retry: false, gcTime: 60000 });
  const label = item.data.status === "running" ? "正在查看 1 张图像" : item.data.status === "failed" ? "查看图像失败" : item.data.status === "canceled" ? "已取消查看图像" : "已查看 1 张图像";
  const filename = item.data.filePath.split(/[\\/]/).pop() || "图像预览";
  const ratio = size.width / size.height;
  const thumbnailWidth = Math.min(160, 112 * ratio);

  return <View style={{ gap: 8, paddingVertical: 6 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={{ flexDirection: "row", alignItems: "center", gap: 7, alignSelf: "flex-start", paddingVertical: 2 }}>
      <Icon name="Images" size={15} color={theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{label}</Text>
      <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={13} color={theme.colors.foregroundMuted} />
    </Pressable>
    {expanded && <View style={{ gap: 6, alignItems: "flex-start" }}>
      {query.isPending && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>正在加载图片…</Text>}
      {query.error && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{String(query.error)}</Text>}
      {query.data && <Pressable accessibilityRole="button" accessibilityLabel={`放大查看 ${filename}`} onPress={() => setOpen(true)} style={({ pressed }) => ({ borderRadius: 9, overflow: "hidden", borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, opacity: pressed ? 0.8 : 1 })}>
        <Image source={{ uri: query.data.uri }} resizeMode="contain" style={{ width: thumbnailWidth, height: thumbnailWidth / ratio }} accessibilityLabel={filename} onLoad={({ nativeEvent }) => {
          const source = nativeEvent.source;
          if (source?.width > 0 && source?.height > 0) setSize(previous => previous.width === source.width && previous.height === source.height ? previous : { width: source.width, height: source.height });
        }} />
      </Pressable>}
      <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: theme.colors.foregroundMuted, fontSize: 11, maxWidth: 220 }}>{filename}</Text>
    </View>}
    {open && query.data && <ImageViewer filename={filename} filePath={item.data.filePath} uri={query.data.uri} size={size} theme={theme} layout={layout} onClose={() => setOpen(false)} />}
  </View>;
}

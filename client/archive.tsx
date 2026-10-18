import { useRpc, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Pressable, ScrollView, Text, View } from "react-native";
import { archiveChildren, archiveChild } from "../shared/archive";

export function ArchivePanel({ agentId, theme, layout }: PluginAgentPanelProps) {
  const list = useRpc(archiveChildren), archive = useRpc(archiveChild);
  const query = useQuery({ queryKey: ["desktop-archive", agentId], queryFn: () => list({ agentId }), refetchInterval: false });
  const mutation = useMutation({ mutationFn: (threadId: string) => archive({ agentId, threadId }), onSuccess: () => query.refetch() });
  const text = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted };
  return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}>
    <Text style={{ ...text, fontSize: 20 }}>Desktop 子会话归档</Text>
    <Text style={muted}>归档保留聊天历史并释放监听。归档整个 Paseo 工作区时，会自动归档它所属的 Desktop 主会话和子会话。</Text>
    {query.isPending && <Text style={muted}>正在读取子会话…</Text>}
    {query.error && <Text style={text}>{String(query.error)}</Text>}
    {mutation.error && <Text style={text}>{String(mutation.error)}</Text>}
    {query.data?.children.length === 0 && <Text style={muted}>这个 Desktop agent 尚无原生子会话。</Text>}
    {query.data?.children.map(child => <View key={child.threadId} style={{ gap: 8, paddingVertical: 12 }}>
      <Text style={text}>{child.title}</Text>
      <Text style={muted} selectable>{child.threadId}</Text>
      <Text style={muted}>{child.pending ? "归档同步待处理" : child.archived ? "已归档" : "尚未归档"}</Text>
      {child.error && <Text style={text}>{child.error}</Text>}
      <Pressable accessibilityRole="button" accessibilityLabel={`归档 ${child.title}`} disabled={mutation.isPending || (child.archived && !child.pending)} onPress={() => mutation.mutate(child.threadId)} style={{ padding: 10, backgroundColor: theme.colors.surface1, opacity: mutation.isPending || child.archived ? 0.5 : 1 }}>
        <Text style={text}>{child.pending ? "重试归档同步" : "归档这个子会话"}</Text>
      </Pressable>
    </View>)}
  </ScrollView>;
}

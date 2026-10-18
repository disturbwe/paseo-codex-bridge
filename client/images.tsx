import { useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { imagePreview } from "../shared/images";

type Data={callId:string;filePath:string;status:string};
export function ImageViewRow({agentId,item,theme,layout}:PluginTimelineItemProps<Data>){
  const [expanded,setExpanded]=useState(false),[zoom,setZoom]=useState(false);
  const preview=useRpc(imagePreview);
  const query=useQuery({queryKey:["desktop-image",agentId,item.data.callId],queryFn:()=>preview({agentId,callId:item.data.callId}),enabled:expanded,refetchInterval:false,refetchOnWindowFocus:false,retry:false,gcTime:60000});
  const label=item.data.status==="running"?"正在查看 1 张图像":item.data.status==="failed"?"查看图像失败":item.data.status==="canceled"?"已取消查看图像":"已查看 1 张图像";
  return <View style={{gap:8,paddingVertical:8}}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{expanded}} onPress={()=>setExpanded(!expanded)} style={{flexDirection:"row",alignItems:"center",gap:8}}>
      <Icon name="Images" size={16} color={theme.colors.foregroundMuted}/>
      <Text style={{color:theme.colors.foregroundMuted}}>{label}</Text>
      <Icon name={expanded?"ChevronDown":"ChevronRight"} size={14} color={theme.colors.foregroundMuted}/>
    </Pressable>
    {expanded&&<View style={{gap:8}}>
      <Text selectable style={{color:theme.colors.foregroundMuted,fontSize:12}}>{item.data.filePath}</Text>
      {query.isPending&&<Text style={{color:theme.colors.foregroundMuted}}>正在加载原图…</Text>}
      {query.error&&<Text style={{color:theme.colors.foregroundMuted}}>{String(query.error)}</Text>}
      {query.data&&<Pressable accessibilityRole="button" accessibilityLabel="放大查看图像" onPress={()=>setZoom(true)}>
        <Image source={{uri:query.data.uri}} resizeMode="contain" style={{width:layout.compact?200:280,height:158,borderRadius:8}} accessibilityLabel="Desktop 已查看的图像预览"/>
      </Pressable>}
    </View>}
    <Modal title="Desktop 已查看的图像" open={zoom} onOpenChange={setZoom}>
      <Modal.Content>{query.data&&<Image source={{uri:query.data.uri}} resizeMode="contain" style={{width:"100%",height:layout.compact?320:560}}/>}</Modal.Content>
    </Modal>
  </View>;
}

import fs from "node:fs";
import { fileURLToPath } from "node:url";
export function imagePath(value: unknown): string | null {
  if(typeof value!=="string"||!value)return null;
  if(value.startsWith("file:")){try{return fileURLToPath(value);}catch{return null;}}
  return value;
}
export function readImagePreview(file: string) {
  const fd=fs.openSync(file,"r");
  try {
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.size>4*1024*1024)throw new Error("预览支持不超过 4 MiB 的图片");
    const bytes=Buffer.alloc(stat.size);let offset=0;
    while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)break;offset+=count;}
    const body=bytes.subarray(0,offset);
    const mime=body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?"image/png":body[0]===255&&body[1]===216&&body[2]===255?"image/jpeg":/^GIF8[79]a/.test(body.subarray(0,6).toString())?"image/gif":body.subarray(0,4).toString()==="RIFF"&&body.subarray(8,12).toString()==="WEBP"?"image/webp":null;
    if(!mime)throw new Error("预览仅支持 PNG、JPEG、GIF 和 WebP");
    return {uri:`data:${mime};base64,${body.toString("base64")}`};
  } finally {fs.closeSync(fd);}
}

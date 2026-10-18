import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {imagePath,readImagePreview} from "./images";

test("Native file URIs become platform paths without changing plain Desktop paths",()=>{
  const file=path.join(os.tmpdir(),"image with spaces.png");
  assert.equal(imagePath(pathToFileURL(file).href),file);assert.equal(imagePath(file),file);
  assert.equal(imagePath(undefined),null);
});
test("Preview serves bounded raster bytes and rejects unsupported or oversized files",()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"paseo-image-")),file=path.join(directory,"preview.png");
  try{
    const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";
    fs.writeFileSync(file,Buffer.from(png,"base64"));assert.equal(readImagePreview(file).uri,`data:image/png;base64,${png}`);
    fs.writeFileSync(file,"<svg/>" );assert.throws(()=>readImagePreview(file),/PNG/);
    const fd=fs.openSync(file,"w");fs.ftruncateSync(fd,4*1024*1024+1);fs.closeSync(fd);assert.throws(()=>readImagePreview(file),/4 MiB/);
  }finally{fs.unlinkSync(file);fs.rmdirSync(directory);}
});

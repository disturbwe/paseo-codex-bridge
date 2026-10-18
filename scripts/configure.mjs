import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const threadId=process.argv[2];
if(!threadId||!/^[0-9a-f-]{36}$/i.test(threadId)){console.error("Usage: node scripts/configure.mjs <Codex Desktop caller thread ID>");process.exit(1);}
const directory=process.env.PASEO_CODEX_BRIDGE_DATA_DIR??path.join(process.env.PASEO_HOME??path.join(os.homedir(),".paseo"),"plugin-data","paseo-codex-bridge");
fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,"config.json");
let config={};try{config=JSON.parse(fs.readFileSync(file,"utf8"));}catch(error){if(error.code!=="ENOENT")throw error;}
fs.writeFileSync(file,JSON.stringify({...config,callerThreadId:threadId},null,2)+"\n",{mode:0o600});console.log(`Configured ${file}. Reload plugin paseo-codex-desktop.`);

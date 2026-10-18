import { AppTools, DesktopEvents } from "../server/native";
import { callerThreadId } from "../server/config";
async function main() {
let requests=0;const tools=new AppTools(callerThreadId,()=>requests++),events=new DesktopEvents(()=>requests++);
try {
  const schema=await tools.describe("create_thread");
  if(!schema.inputSchema?.properties?.model)throw new Error("Desktop model schema is unavailable");
  const list=await tools.call("list_threads",{limit:1});
  const snapshot=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("No Desktop snapshot received")),15000);events.onChange=(id,change)=>{if(id===callerThreadId()&&change.type==="snapshot"){clearTimeout(timer);resolve();}};});
  void snapshot.catch(()=>{});await events.follow(callerThreadId());await snapshot;
  console.log(JSON.stringify({success:true,platform:process.platform,requests,pollingRequests:0,toolsAndEventSubscription:true}));
} finally {tools.close();events.close();}

}
void main().catch(error => {console.error(error);process.exitCode=1;});

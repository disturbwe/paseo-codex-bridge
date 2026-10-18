import test from "node:test";
import assert from "node:assert/strict";
import { RolloutReducer } from "./rollout";
import { ProviderEventSchema } from "@getpaseo/plugin/server/provider";
import { timelineFromItem } from "./provider";

test("Background Desktop rollout maps public child output and terminal state without window ownership", () => {
  const reducer = new RolloutReducer("child");
  reducer.accept({ type: "session_meta", payload: { agent_nickname: "Worker", cwd: "C:/test" } });
  reducer.accept({ type: "event_msg", payload: { type: "task_started", turn_id: "turn" } });
  reducer.accept({ type: "response_item", payload: { type: "message", role: "developer", content: [{ text: "private developer instructions" }] } });
  reducer.accept({ type: "event_msg", payload: { type: "item_completed", turn_id: "turn", item: { type: "Reasoning", id: "private", content: ["private reasoning"] } } });
  reducer.accept({ type: "turn_context", payload: { model: "native-model", effort: "high" } });
  reducer.accept({ type: "event_msg", payload: { type: "item_completed", turn_id: "turn", item: { type: "CommandExecution", id: "cmd", command: ["pwsh.exe", "-Command", "npm test"], status: "Completed", aggregated_output: "passed", exit_code: 0 } } });
  reducer.accept({ type: "event_msg", payload: { type: "item_completed", turn_id: "turn", item: { type: "AgentMessage", id: "reply", content: [{ type: "Text", text: "done" }], phase: "final_answer" } } });
  reducer.accept({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn", last_agent_message: "done" } });
  assert.equal(reducer.state.title, "Worker");
  assert.equal(reducer.state.latestModel, "native-model");
  assert.equal(reducer.state.turns[0].status, "completed");
  assert.equal(reducer.state.turns[0].items.length, 2);
  assert.equal(reducer.state.turns[0].items[0].aggregatedOutput, "passed");
  for (const native of reducer.state.turns[0].items) ProviderEventSchema.parse({ type: "timeline.item", sessionId: "child", item: timelineFromItem(native) });
  assert.ok(!JSON.stringify(reducer.state).includes("private"));
});

test("Background ImageView events keep their stable identity across start and completion",()=>{
  const reducer=new RolloutReducer("child");reducer.accept({type:"event_msg",payload:{type:"task_started",turn_id:"turn"}});
  for(const type of ["item_started","item_completed"]){reducer.accept({type:"event_msg",payload:{type,item:{type:"ImageView",id:"image",path:"file:///tmp/result.png"}}});}
  assert.equal(reducer.state.turns[0].items.length,1);
  assert.deepEqual(reducer.state.turns[0].items[0],{type:"imageView",id:"image",path:"file:///tmp/result.png",status:"completed"});
});

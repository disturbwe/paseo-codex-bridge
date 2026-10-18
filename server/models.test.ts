import test from "node:test";
import assert from "node:assert/strict";
import { modelsFromToolSchema } from "./models";

test("Desktop models use live tool schema IDs and per-model reasoning allowlists", () => {
  const tool = { inputSchema: { properties: { model: { description: "Models and supported reasoning efforts on the calling host: vendor/model-a (Model A; supported reasoning efforts: low, high), model-b (Model B; supported reasoning efforts: none)." } } } };
  const models = modelsFromToolSchema(tool);
  assert.deepEqual(models.map(model => model.id), ["desktop", "vendor/model-a", "model-b"]);
  assert.deepEqual(models[1].thinkingOptions?.map(option => option.id), ["low", "high"]);
  assert.deepEqual(models[2].thinkingOptions?.map(option => option.id), ["none"]);
  assert.throws(() => modelsFromToolSchema({}), /模型列表/);
  assert.throws(() => modelsFromToolSchema({ inputSchema: { properties: { model: { description: "changed protocol" } } } }), /无法解析/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { patchGoalBarBundle } from "../scripts/goal-bar-style.mjs";

const fixture = `function render(u,p){const x=u.placement==="composer",b=u.button,t=false,n=false,j=false;let P=b.label;x?P=b.label??b.title:p.layout.compact&&(P=void 0);const se={button:{maxWidth:160},active:{},disabled:{}},w={composerPillStyles:{body:{height:32}}};return {label:P,styles:[w.composerPillStyles.body,se.button,(t||n||u.open)&&se.active,j&&se.disabled]};}`;
// Match the renderer's comma expression; keep this fixture executable for layout assertions.
const bundle = fixture.replace('p.layout.compact&&(P=void 0);const', 'p.layout.compact&&(P=void 0),P=P;const');
function render(source, id, pluginId = "paseo-codex-desktop", compact = false) {
  const run = new Function(`${source};return render;`)();
  const result = run({ id, installation: { id: pluginId }, placement: "composer", button: { label: "目标", title: "Accessible action" } }, { layout: { compact } });
  return { label: result.label, style: Object.assign({}, ...result.styles.filter(Boolean)) };
}
test("Goal style adapter widens only this plugin's goal and keeps controls icon-only and 28px", () => {
  const result = patchGoalBarBundle(bundle);
  assert.equal(render(result.source, "desktop-goal").style.maxWidth, 420);
  assert.equal(render(result.source, "desktop-goal", undefined, true).style.maxWidth, 220);
  for (const id of ["goal-toggle", "goal-clear"]) {
    const button = render(result.source, id); assert.equal(button.label, undefined);
    assert.equal(button.style.width, 28); assert.equal(button.style.height, 28);
  }
  assert.equal(render(result.source, "desktop-goal", "another-plugin").style.maxWidth, 160);
  assert.equal(render(result.source, "goal-clear", "another-plugin").label, "目标");
});
test("Goal style adapter is idempotent and refuses unfamiliar or ambiguous renderers", () => {
  const patched = patchGoalBarBundle(bundle);
  assert.deepEqual(patchGoalBarBundle(patched.source), { source: patched.source, changed: false });
  assert.throws(() => patchGoalBarBundle("unfamiliar app"), /no files changed/);
  assert.throws(() => patchGoalBarBundle(bundle + bundle), /no files changed/);
});

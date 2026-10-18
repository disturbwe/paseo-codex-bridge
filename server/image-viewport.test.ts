import test from "node:test";
import assert from "node:assert/strict";
import { clampPan, clampScale, fitScale, zoomAt } from "../shared/image-viewport";
const image = { width: 1600, height: 900 }, canvas = { width: 800, height: 500 };

test("Fit keeps landscape and portrait images visible and does not enlarge small images", () => {
  assert.equal(fitScale(image,canvas),0.5);
  assert.equal(fitScale({width:900,height:1600},canvas),0.3125);
  assert.equal(fitScale({width:160,height:90},canvas),1);
});
test("Zoom around the cursor preserves its image point until the pan boundary is reached", () => {
  const before={x:30,y:-20},anchor={x:100,y:50};
  const after=zoomAt(before,1,2,anchor,image,canvas);
  assert.equal((anchor.x-before.x)/1,(anchor.x-after.x)/2);
  assert.equal((anchor.y-before.y)/1,(anchor.y-after.y)/2);
});
test("Dragging cannot lose the image outside the canvas and shrinking recenters it", () => {
  assert.deepEqual(clampPan({x:9999,y:-9999},image,canvas,1),{x:400,y:-200});
  assert.deepEqual(zoomAt({x:400,y:-200},1,0.5,{x:0,y:0},image,canvas),{x:0,y:0});
});
test("Zoom remains between its usable minimum and 800%, even for large images", () => {
  assert.equal(clampScale(99,0.5),8);assert.equal(clampScale(0.001,0.5),0.1);
  assert.equal(clampScale(0.001,0.04),0.04);
});

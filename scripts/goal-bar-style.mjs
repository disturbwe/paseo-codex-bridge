export const goalStyleMarker = "paseo-codex-bridge-goal-style-v1";
const labelAnchor = 'x?P=b.label??b.title:p.layout.compact&&(P=void 0),';
const styleAnchor = '[w.composerPillStyles.body,se.button,(t||n||u.open)&&se.active,j&&se.disabled]';
const owned = 'u.installation.id==="paseo-codex-desktop"';
const controls = '["goal-toggle","goal-clear"].includes(u.id)';
export function patchGoalBarBundle(source) {
  if (source.includes(goalStyleMarker)) return { source, changed: false };
  for (const anchor of [labelAnchor, styleAnchor]) {
    if (source.split(anchor).length !== 2) throw new Error("Unsupported Paseo composer renderer; no files changed.");
  }
  const label = `${labelAnchor}/*${goalStyleMarker}*/x&&${owned}&&${controls}&&(P=void 0),`;
  const style = `[w.composerPillStyles.body,se.button,${owned}&&(u.id==="desktop-goal"?{maxWidth:p.layout.compact?220:420}:` +
    `${controls}?{width:28,minWidth:28,maxWidth:28,height:28,paddingHorizontal:0,gap:0,borderWidth:0,borderRadius:14,justifyContent:"center",backgroundColor:"transparent"}:` +
    `u.id==="goal-duration"?{height:28,paddingHorizontal:6,borderWidth:0,backgroundColor:"transparent"}:undefined),(t||n||u.open)&&se.active,j&&se.disabled]`;
  return { source: source.replace(labelAnchor, label).replace(styleAnchor, style), changed: true };
}

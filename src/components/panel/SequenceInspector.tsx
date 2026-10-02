import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { changeClipRate, clipVolumeAt, evaluateClipTransform, setSequence } from "../../sequence/engine";
import { linkedClipIds, moveTimelineClips, trimLinkedClips } from "../../sequence/editing";
import type { Clip, Live2DActor, ProjectDocument, Sequence } from "../../sequence/types";
import "./SequenceInspector.css";
import PropertyCurveEditor from "./PropertyCurveEditor";
import { patchClips, rollCut, slipClips, crossfadeAudio } from "../../sequence/advancedEditing";
import { propertyLabels, gainToDb, dbToGain, editPropertiesAt } from "../../sequence/properties";
import type { PropertyName } from "../../sequence/types";

export type SequenceSelection = { sequenceId: string; clipIds: string[]; actorId?: string; trackId?: string };
type Props = {
  project: ProjectDocument;
  onProjectChange: (document: ProjectDocument) => void;
  selection: SequenceSelection;
  time: number;
  onBeginEdit: () => void;
  onEndEdit: () => void;
  linkedSelection?: boolean;
};

function Section({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return <section className="workspace-section"><header className="workspace-section-header"><h3 className="workspace-section-title">{title}</h3>{meta}</header><div className="workspace-section-body">{children}</div></section>;
}

function NumberField({ label, value, onChange, min, max, step = 1 }: { label: string; value: number | undefined; onChange: (value: number) => void; min?: number; max?: number; step?: number }) {
  return <label className="field-stack"><span className="field-label">{label}</span><input className="input" aria-label={label} type="number" step={step} min={min} max={max} placeholder={value == null ? "不同值" : undefined} value={value == null ? "" : Number(value.toFixed(4))} onChange={(event) => {
    const next = event.target.valueAsNumber;
    if (Number.isFinite(next)) onChange(next);
  }} /></label>;
}

export default function SequenceInspector({ project, onProjectChange, selection, time, onBeginEdit, onEndEdit, linkedSelection = true }: Props) {
  const [issue, setIssue] = useState("");
  const editingRef = useRef(false);
  const editCallbacksRef = useRef({ begin: onBeginEdit, end: onEndEdit });
  editCallbacksRef.current = { begin: onBeginEdit, end: onEndEdit };
  const sequence = project.sequences[selection.sequenceId] ?? project.sequences[project.rootSequenceId];
  const chosen = project.sequences[selection.sequenceId] ? sequence.tracks.flatMap((track) => track.clips.filter((clip) => selection.clipIds.includes(clip.id)).map((clip) => ({ clip, track }))).sort((a, b) => selection.clipIds.indexOf(a.clip.id) - selection.clipIds.indexOf(b.clip.id)) : [];
  const item = chosen[0];
  const trackSelection = sequence.tracks.find(track => track.id === selection.trackId);
  const mixed = (read: (clip: Clip) => number, items = chosen) => { const values = items.map(item => read(item.clip)); return values.length && values.every(value => Math.abs(value-values[0]) < 1e-6) ? values[0] : undefined; };
  const at = (clip: Clip) => Math.max(0, clip.sourceIn+(time-clip.start)*clip.rate);
  const clip = item?.clip;
  const actor = sequence.kind === "live2d" ? sequence.actors.find((candidate) => candidate.id === selection.actorId) : undefined;
  const asset = clip?.assetId ? project.assets[clip.assetId] : undefined;
  const selectionKey = `${selection.sequenceId}:${selection.clipIds.join(",")}:${selection.actorId ?? ""}`;
  const endFocusEdit = () => {
    if (!editingRef.current) return;
    editingRef.current = false; editCallbacksRef.current.end();
  };
  useEffect(() => { setIssue(""); endFocusEdit(); }, [selectionKey, project.id]);
  useEffect(() => () => endFocusEdit(), []);
  const apply = (command: (document: ProjectDocument) => ProjectDocument) => {
    try { onProjectChange(command(project)); setIssue(""); }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)); }
  };
  const patch = (value: Partial<Clip>) => {
    if (!item) return;
    apply((document) => patchClips(document, sequence.id, chosen.map(item => item.clip.id), () => value));
  };
  const patchProperty = (name: PropertyName, value: number) => apply(document => patchClips(document, sequence.id, chosen.filter(item => name === "volume" ? ["audio","sequence"].includes(item.clip.kind) : item.clip.kind !== "audio").map(item => item.clip.id), candidate => {
    return editPropertiesAt(candidate,at(candidate),{[name]:value});
  }));
  const propertyFields = (names:PropertyName[]) => names.map(name => {
    const targets=chosen.filter(item => name === "volume" ? ["audio","sequence"].includes(item.clip.kind) : item.clip.kind !== "audio");
    if(!targets.length)return null;
    const base=targets[0].clip, curve=base.propertyCurves?.[name];
    const read=(candidate:Clip) => name === "volume" ? clipVolumeAt(candidate,at(candidate)) : evaluateClipTransform(candidate,at(candidate))[name];
    const allAnimated=targets.every(item=>item.clip.propertyCurves?.[name]?.enabled);
    return <div key={name} className="property-field"><div className="property-field-value"><NumberField label={name === "volume" ? "音量 dB" : propertyLabels[name]} value={name === "volume" ? mixed(c=>gainToDb(read(c)),targets) : mixed(read,targets)} min={name === "opacity"?0:name.includes("scale")?0.01:name==="volume"?-60:undefined} max={name === "opacity"?1:name==="volume"?12:undefined} step={name==="volume"?1:0.05} onChange={value=>patchProperty(name,name === "volume"?dbToGain(value):name === "opacity"?Math.max(0,Math.min(1,value)):value)}/>
    <button className={`btn btn--quiet sequence-key-button${allAnimated?" is-active":""}`} aria-label={`${propertyLabels[name]}动画开关`} aria-pressed={allAnimated} onClick={()=>apply(document=>patchClips(document,sequence.id,targets.map(item=>item.clip.id),candidate=>({propertyCurves:{...candidate.propertyCurves,[name]:{enabled:!allAnimated,keys:candidate.propertyCurves?.[name]?.keys??(name==="volume"?candidate.volumeKeys.map(key=>({...key,interpolation:"linear" as const})):candidate.transformKeys.map(key=>({id:crypto.randomUUID(),time:key.time,value:key[name],interpolation:"linear" as const})))}}})))}>◇</button></div>
    {targets.length===1&&curve&&<PropertyCurveEditor label={propertyLabels[name]} curve={curve} base={name==="volume"?base.volume:base.transform[name]} time={at(base)} duration={base.sourceIn+base.duration*base.rate} onBegin={onBeginEdit} onEnd={onEndEdit} disabled={targets[0].track.locked} onChange={value=>apply(document=>patchClips(document,sequence.id,[base.id],()=>({propertyCurves:{...base.propertyCurves,[name]:value}})))}/>}
    </div>;
  });
  const patchCanvas = (value: Partial<Pick<Sequence, "width" | "height" | "fps">>) => {
    const next = { ...sequence, ...value };
    if (![next.width, next.height, next.fps].every(Number.isFinite) || next.width < 16 || next.height < 16 || next.width > 16384 || next.height > 16384 || next.fps <= 0 || next.fps > 240) {
      setIssue("画布范围 16–16384，帧率范围 1–240。"); return;
    }
    apply((document) => {
      const updated = setSequence(document, next);
      return sequence.id === document.rootSequenceId ? { ...updated, width: next.width, height: next.height, fps: next.fps } : updated;
    });
  };
  const patchActor = (value: Partial<Live2DActor>) => {
    if (!actor || sequence.kind !== "live2d") return;
    apply((document) => setSequence(document, { ...sequence, actors: sequence.actors.map((candidate) => candidate.id === actor.id ? { ...candidate, ...value } : candidate) }));
  };
  return <div className="sequence-inspector" onFocusCapture={(event) => { if ((event.target as HTMLElement).matches("input,select,textarea") && !editingRef.current) { editingRef.current = true; editCallbacksRef.current.begin(); } }} onBlurCapture={(event) => { if ((event.target as HTMLElement).matches("input,select,textarea")) endFocusEdit(); }}>
    {issue && <p className="sequence-inspector-issue" role="alert">{issue}</p>}
    {clip && item ? <>
      <Section title={chosen.length > 1 ? `片段 · ${chosen.length}` : "片段"} meta={item.track.locked ? <span className="workspace-section-meta">已锁定</span> : undefined}>
        <fieldset disabled={chosen.some(item=>item.track.locked)}>
          <label className="field-stack"><span className="field-label">名称</span><input className="input" aria-label="片段名称" value={clip.name} onChange={(event) => patch({ name: event.target.value })} /></label>
          <div className="transform-grid">
            <NumberField label="开始" value={clip.start} min={0} step={1 / sequence.fps} onChange={(value) => apply((document) => moveTimelineClips(document, sequence.id, linkedSelection ? linkedClipIds(sequence, chosen.map(item=>item.clip.id)) : chosen.map(item=>item.clip.id), clip.id, item.track.id, value, "free"))} />
            <NumberField label="时长" value={mixed(c=>c.duration)} min={1 / sequence.fps} step={1 / sequence.fps} onChange={(value) => apply((document) => trimLinkedClips(document, sequence.id, linkedSelection ? linkedClipIds(sequence, chosen.map(item=>item.clip.id)) : chosen.map(item=>item.clip.id), "right", value - clip.duration))} />
            <NumberField label="入点" value={mixed(c=>c.sourceIn)} min={0} step={1 / sequence.fps} onChange={(value) => patch({ sourceIn: Math.max(0, value) })} />
            <NumberField label="速率" value={mixed(c=>c.rate)} min={0.01} max={8} step={0.1} onChange={(value) => apply((document) => chosen.reduce((next,item)=>changeClipRate(next,sequence.id,item.track.id,item.clip.id,value,sequence.fps),document))} />
          </div>
          <div className="sequence-edit-actions"><button className="btn btn--quiet" title="保持位置，移动素材入点一帧" onClick={()=>apply(document=>slipClips(document,sequence.id,chosen.map(item=>item.clip.id),-1/sequence.fps))}>素材 ‹</button><button className="btn btn--quiet" onClick={()=>apply(document=>slipClips(document,sequence.id,chosen.map(item=>item.clip.id),1/sequence.fps))}>素材 ›</button>{chosen.length===1&&<><button className="btn btn--quiet" title="与右侧片段滚动修剪一帧" onClick={()=>apply(document=>rollCut(document,sequence.id,clip.id,-1/sequence.fps))}>切点 ‹</button><button className="btn btn--quiet" onClick={()=>apply(document=>rollCut(document,sequence.id,clip.id,1/sequence.fps))}>切点 ›</button></>}</div>
        </fieldset>
      </Section>
      {clip.sequenceId&&Object.values(project.sequences).flatMap(sequence=>sequence.tracks.flatMap(track=>track.clips)).filter(candidate=>candidate.sequenceId===clip.sequenceId).length>1&&<p className="pane-note">共享序列 · 修改内部影响全部引用</p>}
      {chosen.some(item=>item.clip.kind!=="audio")&&<Section title="画面"><fieldset disabled={chosen.some(item=>item.track.locked)}><div className="transform-grid">{propertyFields(["x","y","scaleX","scaleY","rotation","opacity"])}</div></fieldset></Section>}
      {chosen.some(item=>["audio","sequence"].includes(item.clip.kind)) && <Section title="声音">
        <fieldset disabled={chosen.some(item=>item.track.locked)}><div className="transform-grid">
          {propertyFields(["volume"])}
          <NumberField label="淡入" value={mixed(c=>c.fadeIn)} min={0} max={clip.duration} step={0.1} onChange={(value) => patch({ fadeIn: Math.max(0, Math.min(clip.duration, value)) })} />
          <NumberField label="淡出" value={mixed(c=>c.fadeOut)} min={0} max={clip.duration} step={0.1} onChange={(value) => patch({ fadeOut: Math.max(0, Math.min(clip.duration, value)) })} />
        </div><label className="field-stack"><span>保留音调</span><input type="checkbox" checked={chosen.every(item=>item.clip.preservePitch===true)} onChange={event=>patch({preservePitch:event.target.checked})}/></label>{chosen.filter(item=>item.clip.kind==="audio").length===2&&<button className="btn btn--quiet" onClick={()=>apply(document=>crossfadeAudio(document,sequence.id,chosen.map(item=>item.clip.id),1))}>交叉淡化</button>}{clip.kind === "audio" && <label className="field-stack"><span className="field-label">口型</span><select className="input" aria-label="口型目标" value={clip.lipSyncActorId ?? ""} onChange={(event) => patch({ lipSyncActorId: event.target.value || undefined })}><option value="">不绑定</option>{Object.values(project.sequences).flatMap((child) => child.kind === "live2d" ? child.actors.map((actor) => <option value={actor.id} key={actor.id}>{child.name} · {actor.name}</option>) : [])}</select></label>}{clip.kind === "audio"&&<NumberField label="口型偏移" value={mixed(c=>c.lipSyncOffset??0)} step={0.01} onChange={value=>patch({lipSyncOffset:value})}/>}</fieldset>
      </Section>}
      {clip.kind === "text" && <Section title="文字">
        <fieldset disabled={chosen.some(item=>item.track.locked)}>
          <label className="field-stack"><span className="field-label">内容</span><textarea className="input" aria-label="文字内容" rows={3} value={clip.text ?? ""} onChange={(event) => patch({ text: event.target.value })} /></label>
          <label className="field-stack"><span className="field-label">字体</span><input className="input" aria-label="字体" value={clip.fontFamily ?? String(asset?.metadata?.fontFamily ?? "sans-serif")} onChange={(event) => patch({ fontFamily: event.target.value })} /></label>
          <div className="transform-grid"><NumberField label="字号" value={clip.fontSize ?? Number(asset?.metadata?.fontSize ?? 34)} min={1} max={500} onChange={(value) => patch({ fontSize: Math.max(1, value) })} /><label className="field-stack"><span className="field-label">颜色</span><input className="input" aria-label="文字颜色" type="color" value={clip.textColor ?? String(asset?.metadata?.color ?? "#ffffff")} onChange={(event) => patch({ textColor: event.target.value })} /></label></div>
        </fieldset>
      </Section>}
    </> : actor ? <>
      <Section title="角色">
        <label className="field-stack"><span className="field-label">名称</span><input className="input" aria-label="角色名称" value={actor.name} onChange={(event) => patchActor({ name: event.target.value })} /></label>
        <label className="switch-row"><input aria-label="显示角色" type="checkbox" checked={actor.visible} onChange={(event) => patchActor({ visible: event.target.checked })} /><span>显示</span></label>
      </Section>
      <Section title="画面"><div className="transform-grid">
        <NumberField label="X" value={actor.transform.x} onChange={(value) => patchActor({ transform: { ...actor.transform, x: value } })} />
        <NumberField label="Y" value={actor.transform.y} onChange={(value) => patchActor({ transform: { ...actor.transform, y: value } })} />
        <NumberField label="横向缩放" value={actor.transform.scaleX} min={0.01} step={0.05} onChange={(value) => patchActor({ transform: { ...actor.transform, scaleX: Math.max(0.01, value) } })} />
        <NumberField label="纵向缩放" value={actor.transform.scaleY} min={0.01} step={0.05} onChange={(value) => patchActor({ transform: { ...actor.transform, scaleY: Math.max(0.01, value) } })} />
        <NumberField label="旋转" value={actor.transform.rotation} onChange={(value) => patchActor({ transform: { ...actor.transform, rotation: value } })} />
        <NumberField label="透明度" value={actor.transform.opacity} min={0} max={1} step={0.05} onChange={(value) => patchActor({ transform: { ...actor.transform, opacity: Math.min(1, Math.max(0, value)) } })} />
      </div></Section>
    </> : trackSelection ? <Section title="轨道"><label className="field-stack"><span>名称</span><input className="input" value={trackSelection.name} onChange={event=>apply(document=>setSequence(document,{...sequence,tracks:sequence.tracks.map(track=>track.id===trackSelection.id?{...track,name:event.target.value}:track)}))}/></label>{([['locked','锁定'],['hidden','隐藏画面'],['muted','静音']] as const).map(([property,label])=><label className="field-stack" key={property}><span>{label}</span><input type="checkbox" checked={trackSelection[property]} onChange={event=>apply(document=>setSequence(document,{...sequence,tracks:sequence.tracks.map(track=>track.id===trackSelection.id?{...track,[property]:event.target.checked}:track)}))}/></label>)}</Section> : <Section title={sequence.name}>
      <label className="field-stack"><span className="field-label">名称</span><input className="input" aria-label="序列名称" value={sequence.name} onChange={(event) => apply((document) => setSequence(document, { ...sequence, name: event.target.value }))} /></label>
      <div className="transform-grid"><NumberField label="宽度" value={sequence.width} min={16} max={16384} onChange={(value) => patchCanvas({ width: Math.round(value) })} /><NumberField label="高度" value={sequence.height} min={16} max={16384} onChange={(value) => patchCanvas({ height: Math.round(value) })} /><NumberField label="帧率" value={sequence.fps} min={1} max={240} step={1} onChange={(value) => patchCanvas({ fps: value })} /></div>
      <span className="pane-note">选择片段以编辑</span>
    </Section>}
  </div>;
}

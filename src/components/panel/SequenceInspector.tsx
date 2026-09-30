import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { changeClipRate, clipVolumeAt, evaluateClipTransform, moveClip, setSequence, trimClip, updateClip } from "../../sequence/engine";
import type { Clip, Live2DActor, ProjectDocument, Sequence, Transform } from "../../sequence/types";
import "./SequenceInspector.css";

export type SequenceSelection = { sequenceId: string; clipIds: string[]; actorId?: string };
type Props = {
  project: ProjectDocument;
  onProjectChange: (document: ProjectDocument) => void;
  selection: SequenceSelection;
  time: number;
  onBeginEdit: () => void;
  onEndEdit: () => void;
};

function Section({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return <section className="workspace-section"><header className="workspace-section-header"><h3 className="workspace-section-title">{title}</h3>{meta}</header><div className="workspace-section-body">{children}</div></section>;
}

function NumberField({ label, value, onChange, min, max, step = 1 }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number }) {
  return <label className="field-stack"><span className="field-label">{label}</span><input className="input" aria-label={label} type="number" step={step} min={min} max={max} value={Number(value.toFixed(4))} onChange={(event) => {
    const next = event.target.valueAsNumber;
    if (Number.isFinite(next)) onChange(next);
  }} /></label>;
}

export default function SequenceInspector({ project, onProjectChange, selection, time, onBeginEdit, onEndEdit }: Props) {
  const [issue, setIssue] = useState("");
  const editingRef = useRef(false);
  const editCallbacksRef = useRef({ begin: onBeginEdit, end: onEndEdit });
  editCallbacksRef.current = { begin: onBeginEdit, end: onEndEdit };
  const sequence = project.sequences[selection.sequenceId] ?? project.sequences[project.rootSequenceId];
  const chosen = project.sequences[selection.sequenceId] ? sequence.tracks.flatMap((track) => track.clips.filter((clip) => selection.clipIds.includes(clip.id)).map((clip) => ({ clip, track }))).sort((a, b) => selection.clipIds.indexOf(a.clip.id) - selection.clipIds.indexOf(b.clip.id)) : [];
  const item = chosen[0];
  const clip = item?.clip;
  const actor = sequence.kind === "live2d" ? sequence.actors.find((candidate) => candidate.id === selection.actorId) : undefined;
  const clipVisible = !!clip && time >= clip.start && time < clip.start + clip.duration;
  const sourceTime = clip ? Math.max(0, clip.sourceIn + (time - clip.start) * clip.rate) : 0;
  const transform = clip ? evaluateClipTransform(clip, sourceTime) : undefined;
  const volume = clip ? clipVolumeAt(clip, sourceTime) : 1;
  const transformKey = clip?.transformKeys.find((key) => Math.abs(key.time - sourceTime) < 1e-6);
  const volumeKey = clip?.volumeKeys.find((key) => Math.abs(key.time - sourceTime) < 1e-6);
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
    apply((document) => updateClip(document, sequence.id, item.track.id, item.clip.id, value, sequence.fps));
  };
  // Existing property curves insert/update a key at visible source time. Static clips edit their base.
  const patchTransform = (value: Partial<Transform>) => {
    if (!clip || !transform) return;
    if (clip.transformKeys.length && clipVisible) {
      const key = { ...transform, ...value, id: transformKey?.id ?? crypto.randomUUID(), time: sourceTime };
      patch({ transformKeys: [...clip.transformKeys.filter((candidate) => candidate.id !== transformKey?.id), key].sort((a, b) => a.time - b.time) });
    }
    else patch({ transform: { ...clip.transform, ...value } });
  };
  const patchVolume = (value: number) => {
    if (!clip) return;
    if (clip.volumeKeys.length && clipVisible) {
      const key = { id: volumeKey?.id ?? crypto.randomUUID(), time: sourceTime, value };
      patch({ volumeKeys: [...clip.volumeKeys.filter((candidate) => candidate.id !== volumeKey?.id), key].sort((a, b) => a.time - b.time) });
    }
    else patch({ volume: value });
  };
  const keyButton = (kind: "transform" | "volume") => {
    const exists = kind === "transform" ? transformKey : volumeKey;
    const name = kind === "transform" ? "画面" : "音量";
    return <button className={`btn btn--quiet sequence-key-button${exists ? " is-active" : ""}`} disabled={item?.track.locked || !clipVisible} aria-label={`${exists ? "删除" : "添加"}${name}关键帧`} title={clipVisible ? `${exists ? "删除" : "添加"}${name}关键帧 · ${sourceTime.toFixed(3)} 秒` : "播放头不在片段内"} onClick={() => {
      if (!clip || !transform) return;
      if (kind === "transform") patch({ transformKeys: transformKey ? clip.transformKeys.filter((key) => key.id !== transformKey.id) : [...clip.transformKeys, { ...transform, id: crypto.randomUUID(), time: sourceTime }].sort((a, b) => a.time - b.time) });
      else patch({ volumeKeys: volumeKey ? clip.volumeKeys.filter((key) => key.id !== volumeKey.id) : [...clip.volumeKeys, { id: crypto.randomUUID(), time: sourceTime, value: volume }].sort((a, b) => a.time - b.time) });
    }}>{exists ? "◆" : "◇"}</button>;
  };
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
        <fieldset disabled={item.track.locked}>
          <label className="field-stack"><span className="field-label">名称</span><input className="input" aria-label="片段名称" value={clip.name} onChange={(event) => patch({ name: event.target.value })} /></label>
          <div className="transform-grid">
            <NumberField label="开始" value={clip.start} min={0} step={1 / sequence.fps} onChange={(value) => apply((document) => moveClip(document, sequence.id, item.track.id, clip.id, item.track.id, value, sequence.fps).project)} />
            <NumberField label="时长" value={clip.duration} min={1 / sequence.fps} step={1 / sequence.fps} onChange={(value) => apply((document) => trimClip(document, sequence.id, item.track.id, clip.id, "right", value - clip.duration, sequence.fps, asset?.duration))} />
            <NumberField label="入点" value={clip.sourceIn} min={0} step={1 / sequence.fps} onChange={(value) => patch({ sourceIn: Math.max(0, value) })} />
            <NumberField label="速率" value={clip.rate} min={0.01} max={8} step={0.1} onChange={(value) => apply((document) => changeClipRate(document, sequence.id, item.track.id, clip.id, value, sequence.fps))} />
          </div>
        </fieldset>
      </Section>
      {clip.kind !== "audio" && transform && <Section title="画面" meta={keyButton("transform")}>
        <fieldset disabled={item.track.locked}><div className="transform-grid">
          <NumberField label="X" value={transform.x} onChange={(value) => patchTransform({ x: value })} />
          <NumberField label="Y" value={transform.y} onChange={(value) => patchTransform({ y: value })} />
          <NumberField label="横向缩放" value={transform.scaleX} min={0.01} step={0.05} onChange={(value) => patchTransform({ scaleX: Math.max(0.01, value) })} />
          <NumberField label="纵向缩放" value={transform.scaleY} min={0.01} step={0.05} onChange={(value) => patchTransform({ scaleY: Math.max(0.01, value) })} />
          <NumberField label="旋转" value={transform.rotation} onChange={(value) => patchTransform({ rotation: value })} />
          <NumberField label="透明度" value={transform.opacity} min={0} max={1} step={0.05} onChange={(value) => patchTransform({ opacity: Math.min(1, Math.max(0, value)) })} />
        </div></fieldset>
      </Section>}
      {(clip.kind === "audio" || clip.kind === "sequence") && <Section title="声音" meta={keyButton("volume")}>
        <fieldset disabled={item.track.locked}><div className="transform-grid">
          <NumberField label="音量" value={volume} min={0} max={4} step={0.05} onChange={(value) => patchVolume(Math.max(0, value))} />
          <NumberField label="淡入" value={clip.fadeIn} min={0} max={clip.duration} step={0.1} onChange={(value) => patch({ fadeIn: Math.max(0, Math.min(clip.duration, value)) })} />
          <NumberField label="淡出" value={clip.fadeOut} min={0} max={clip.duration} step={0.1} onChange={(value) => patch({ fadeOut: Math.max(0, Math.min(clip.duration, value)) })} />
        </div>{clip.kind === "audio" && <label className="field-stack"><span className="field-label">口型</span><select className="input" aria-label="口型目标" value={clip.lipSyncActorId ?? ""} onChange={(event) => patch({ lipSyncActorId: event.target.value || undefined })}><option value="">不绑定</option>{Object.values(project.sequences).flatMap((child) => child.kind === "live2d" ? child.actors.map((actor) => <option value={actor.id} key={actor.id}>{child.name} · {actor.name}</option>) : [])}</select></label>}</fieldset>
      </Section>}
      {clip.kind === "text" && <Section title="文字">
        <fieldset disabled={item.track.locked}>
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
    </> : <Section title={sequence.name}>
      <label className="field-stack"><span className="field-label">名称</span><input className="input" aria-label="序列名称" value={sequence.name} onChange={(event) => apply((document) => setSequence(document, { ...sequence, name: event.target.value }))} /></label>
      <div className="transform-grid"><NumberField label="宽度" value={sequence.width} min={16} max={16384} onChange={(value) => patchCanvas({ width: Math.round(value) })} /><NumberField label="高度" value={sequence.height} min={16} max={16384} onChange={(value) => patchCanvas({ height: Math.round(value) })} /><NumberField label="帧率" value={sequence.fps} min={1} max={240} step={1} onChange={(value) => patchCanvas({ fps: value })} /></div>
      <span className="pane-note">选择片段以编辑</span>
    </Section>}
  </div>;
}

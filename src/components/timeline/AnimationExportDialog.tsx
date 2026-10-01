import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { animationEnd } from "../../animation/engine";
import type { AnimationDocument } from "../../animation/types";
import type { AnimationExportOptions } from "../../animation/exporters";

type Props = {
  kind: "motion" | "expression";
  animation: AnimationDocument;
  groupId?: string;
  time: number;
  fps: number;
  onClose: () => void;
  onExport: (options: AnimationExportOptions) => Promise<string | undefined>;
};
export default function AnimationExportDialog(p: Props) {
  const group = p.animation.groups.find(item => item.id === p.groupId);
  const parts = [...new Map(p.animation.tracks.map(track => {
    const d = track.definition;
    return [JSON.stringify([d.characterId, d.partId]), { characterId: d.characterId, partId: d.partId }];
  })).entries()];
  const [part, setPart] = useState(parts.find(([, value]) => group?.curves[p.animation.tracks.find(t => t.definition.characterId === value.characterId && t.definition.partId === value.partId)?.definition.target ?? ""])?.[0] ?? parts[0]?.[0] ?? "");
  const [options, setOptions] = useState<Omit<AnimationExportOptions, "characterId" | "partId">>({
    kind: p.kind, name: group?.name ? `${group.name}_编辑` : p.kind === "motion" ? "新动作" : "新表情",
    start: group?.start ?? 0, end: group ? group.start + group.duration : Math.max(1 / p.fps, animationEnd(p.animation)),
    time: p.time, fps: p.fps, fadeIn: 0.5, scope: group ? "material" : "animated", groupId: group?.id, destination: "file",
  });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); }, []);
  const patch = (value: Partial<typeof options>) => { setMessage(""); setOptions(before => ({ ...before, ...value })); };
  const submit = async () => {
    const identity = parts.find(([id]) => id === part)?.[1];
    if (!identity) { setMessage("请先加载角色参数。"); return; }
    if (!options.name.trim()) { setMessage("请输入名称。"); return; }
    setBusy(true); setMessage("");
    try { const result = await p.onExport({ ...options, ...identity, name: options.name.trim() }); if (result) setMessage(result); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return createPortal(<div className="modal-overlay" onClick={() => { if (!busy) p.onClose(); }} onKeyDown={event => {
    event.stopPropagation(); if (event.key === "Escape" && !busy) p.onClose();
    if (event.key === "Tab") {
      const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)"));
      const index = elements.indexOf(window.document.activeElement as HTMLElement);
      if ((event.shiftKey && index <= 0) || (!event.shiftKey && index === elements.length - 1)) {
        event.preventDefault(); elements[event.shiftKey ? elements.length - 1 : 0]?.focus();
      }
    }
  }}><div role="dialog" aria-modal="true" aria-labelledby="animation-export-title" className="modal-box animation-export-dialog" onClick={event => event.stopPropagation()}>
    <h3 id="animation-export-title">{p.kind === "motion" ? "导出动作" : "导出表情"}</h3>
    <fieldset disabled={busy}>
      <label>名称<input ref={nameRef} aria-label="动画名称" value={options.name} onChange={event => patch({ name: event.target.value })} /></label>
      <label>部件<select aria-label="导出部件" value={part} onChange={event => setPart(event.target.value)}>{parts.map(([id, value]) => <option key={id} value={id}>{value.characterId} · {value.partId}</option>)}</select></label>
      <label>参数<select aria-label="导出参数范围" value={options.scope} onChange={event => patch({ scope: event.target.value as AnimationExportOptions["scope"] })}>{group && <option value="material">所选素材涉及的参数</option>}<option value="animated">已动画或已调整</option><option value="all">全部参数</option></select></label>
      {options.kind === "motion" ? <div className="animation-export-range">{(["start", "end", "fps"] as const).map((key, i) => <label key={key}>{["开始", "结束", "帧率"][i]}<input aria-label={`导出${["开始", "结束", "帧率"][i]}`} type="number" min={key === "fps" ? 1 : 0} step={key === "fps" ? 1 : 0.001} value={options[key]} onChange={event => patch({ [key]: event.target.valueAsNumber })} /></label>)}</div>
      : <div className="animation-export-range"><label>姿态时间<input aria-label="表情姿态时间" type="number" min={0} step={0.001} value={options.time} onChange={event => patch({ time: event.target.valueAsNumber })} /></label><label>淡入<input aria-label="表情淡入" type="number" min={0} step={0.1} value={options.fadeIn} onChange={event => patch({ fadeIn: event.target.valueAsNumber })} /></label></div>}
      <label>保存到<select aria-label="动画保存位置" value={options.destination} onChange={event => patch({ destination: event.target.value as AnimationExportOptions["destination"] })}><option value="file">文件</option><option value="model">当前部件的立绘</option></select></label>
      <p>{options.kind === "motion" ? "导出范围内的参数曲线。" : "将指定时间的参数值保存为表情。"}{options.destination === "model" ? "新增文件并登记到模型配置，同名时自动编号。" : ""}</p>
    </fieldset>
    {message && <p className="animation-export-result" role="status">{message}</p>}
    <div className="animation-export-actions"><button className="btn btn--quiet" disabled={busy} onClick={p.onClose}>关闭</button><button className="btn btn--primary" disabled={busy || !parts.length} onClick={() => void submit()}>{busy ? "导出中…" : "导出"}</button></div>
  </div></div>, window.document.body);
}

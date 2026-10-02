import { useEffect, useRef, useState } from "react";
import { curveValue, sortKeys } from "../../animation/engine";
import type { Keyframe, Interpolation } from "../../animation/types";
import type { PropertyCurve } from "../../sequence/types";
type Props = {
    label: string;
    curve: PropertyCurve;
    base: number;
    time: number;
    duration: number;
    onChange: (curve: PropertyCurve) => void;
    onBegin: () => void;
    onEnd: () => void;
    disabled?: boolean;
};
export default function PropertyCurveEditor(p: Props) {
    const [selected, setSelected] = useState("");
    const svg = useRef<SVGSVGElement>(null);
    const endDrag = useRef<(() => void) | null>(null);
    useEffect(() => () => endDrag.current?.(), []);
    const key = p.curve.keys.find(key => key.id === selected);
    const maxTime = Math.max(p.duration, p.time, 1, ...p.curve.keys.map(key => key.time));
    const values = [p.base, ...p.curve.keys.flatMap(key => [key.value, key.inHandle?.value ?? key.value, key.outHandle?.value ?? key.value])];
    const low = Math.min(...values), high = Math.max(...values), span = Math.max(1, high - low);
    const x = (time: number) => 10 + time / maxTime * 260, y = (value: number) => 110 - (value - low) / span * 90;
    const path = Array.from({ length: 130 }, (_, index) => { const time = maxTime * index / 129; return `${index ? "L" : "M"}${x(time)},${y(curveValue(p.curve.keys, p.base, time))}`; }).join(" ");
    const changeKey = (patch: Partial<Keyframe>) => p.onChange({ ...p.curve, keys: sortKeys(p.curve.keys.map(item => {
        if (item.id !== selected) return item;
        const deltaTime=(patch.time??item.time)-item.time, deltaValue=(patch.value??item.value)-item.value;
        return {...item,inHandle:item.inHandle&&{time:item.inHandle.time+deltaTime,value:item.inHandle.value+deltaValue},outHandle:item.outHandle&&{time:item.outHandle.time+deltaTime,value:item.outHandle.value+deltaValue},...patch};
    })) });
    const drag = (event: React.PointerEvent, original: Keyframe, handle?: "inHandle" | "outHandle") => {
        if (p.disabled)
            return;
        endDrag.current?.();
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setSelected(original.id);
        p.onBegin();
        const rect = svg.current!.getBoundingClientRect();
        const move = (pointer: PointerEvent) => {
            const time = Math.max(0, Math.min(maxTime, ((pointer.clientX - rect.left) / rect.width * 280 - 10) / 260 * maxTime));
            const value = low + (110 - (pointer.clientY - rect.top) / rect.height * 120) / 90 * span;
            const keys = p.curve.keys.map(item => item.id !== original.id ? item : handle ? { ...item, [handle]: { time, value } } : { ...item, time, value,
                inHandle: item.inHandle && { time: item.inHandle.time + time - original.time, value: item.inHandle.value + value - original.value },
                outHandle: item.outHandle && { time: item.outHandle.time + time - original.time, value: item.outHandle.value + value - original.value } });
            p.onChange({ ...p.curve, keys: sortKeys(keys) });
        };
        const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); endDrag.current = null; p.onEnd(); };
        endDrag.current = end;
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
    };
    return <details className="property-curve-editor"><summary>{p.label}曲线 · {p.curve.keys.length}</summary><fieldset disabled={p.disabled}>
    <svg ref={svg} viewBox="0 0 280 120" aria-label={`${p.label}曲线`} role="img"><path d={path} fill="none" stroke="currentColor" strokeWidth="2"/><line x1={x(p.time)} x2={x(p.time)} y1="0" y2="120" stroke="#ae503d"/>
      {p.curve.keys.map(item => <g key={item.id}>{item.id === selected && (["inHandle", "outHandle"] as const).map(handle => item[handle] && <g key={handle}><line x1={x(item.time)} y1={y(item.value)} x2={x(item[handle]!.time)} y2={y(item[handle]!.value)} stroke="currentColor"/><circle r="4" cx={x(item[handle]!.time)} cy={y(item[handle]!.value)} fill="#b78347" onPointerDown={event => drag(event, item, handle)}/></g>)}<circle cx={x(item.time)} cy={y(item.value)} r="5" fill={item.id === selected ? "#ae503d" : "#658246"} onPointerDown={event => drag(event, item)}/></g>)}
    </svg>
    <div className="transform-grid"><label className="field-stack"><span>关键帧</span><select className="input" aria-label={`${p.label}关键帧`} value={selected} onChange={event => setSelected(event.target.value)}><option value="">选择</option>{p.curve.keys.map(item => <option key={item.id} value={item.id}>{item.time.toFixed(3)} · {item.value.toFixed(3)}</option>)}</select></label>
    {key && <><label className="field-stack"><span>时间</span><input className="input" type="number" min="0" step="0.001" value={key.time} onChange={event => Number.isFinite(event.target.valueAsNumber) && changeKey({ time: Math.max(0, event.target.valueAsNumber) })}/></label><label className="field-stack"><span>数值</span><input className="input" type="number" step="0.01" value={key.value} onChange={event => Number.isFinite(event.target.valueAsNumber) && changeKey({ value: event.target.valueAsNumber })}/></label><label className="field-stack"><span>插值</span><select className="input" value={key.interpolation} onChange={event => changeKey({ interpolation: event.target.value as Interpolation })}><option value="linear">线性</option><option value="hold">保持</option><option value="inverse-hold">逆保持</option><option value="bezier">贝塞尔</option></select></label>{key.interpolation === "bezier" && (["inHandle", "outHandle"] as const).map(handle => <label className="field-stack" key={handle}><span>{handle === "inHandle" ? "入手柄" : "出手柄"}</span><input className="input" aria-label={`${p.label}${handle === "inHandle" ? "入" : "出"}手柄时间`} type="number" step="0.001" value={key[handle]?.time ?? key.time} onChange={event => Number.isFinite(event.target.valueAsNumber) && changeKey({ [handle]: { time: event.target.valueAsNumber, value: key[handle]?.value ?? key.value } })}/><input className="input" aria-label={`${p.label}${handle === "inHandle" ? "入" : "出"}手柄数值`} type="number" step="0.1" value={key[handle]?.value ?? key.value} onChange={event => Number.isFinite(event.target.valueAsNumber) && changeKey({ [handle]: { time: key[handle]?.time ?? Math.max(0, key.time + (handle === "inHandle" ? -0.2 : 0.2)), value: event.target.valueAsNumber } })}/></label>)}</>}
    </div><button className="btn btn--quiet" onClick={() => { const at = p.curve.keys.find(item => Math.abs(item.time - p.time) < 1e-6); const next = { id: at?.id ?? crypto.randomUUID(), time: p.time, value: curveValue(p.curve.keys, p.base, p.time), interpolation: "linear" as const }; p.onChange({ ...p.curve, enabled: true, keys: sortKeys([...p.curve.keys.filter(item => item.id !== at?.id), next]) }); setSelected(next.id); }}>打帧</button>{key && <button className="btn btn--quiet" onClick={() => { p.onChange({ ...p.curve, keys: p.curve.keys.filter(item => item.id !== selected) }); setSelected(""); }}>删除帧</button>}
  </fieldset></details>;
}

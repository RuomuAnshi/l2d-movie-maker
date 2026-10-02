import { useEffect, useRef, useState } from "react";
import { assetDuration, assetRange } from "../../sequence/sourcePreview";
import { formatTimecode } from "../../sequence/navigation";
import type { ProjectAsset, ProjectDocument } from "../../sequence/types";
type Props = {
    project: ProjectDocument;
    asset: ProjectAsset;
    onAudioPlay?: (time: number, playing: boolean) => Promise<void>;
    onSeek: (time: number) => void;
    onRange: (start: number, end: number) => void;
    onAdd: () => void;
    onClose: () => void;
    onBegin: () => void;
    onEnd: () => void;
};
export default function SourceMonitor(p: Props) {
    const duration = assetDuration(p.project, p.asset), range = assetRange(p.project, p.asset);
    const [time, setTime] = useState(range.sourceIn), [playing, setPlaying] = useState(false);
    const audioCallback=useRef(p.onAudioPlay);audioCallback.current=p.onAudioPlay;
    const seekRef = useRef(p.onSeek);
    seekRef.current = p.onSeek;
    const timeRef = useRef(time);
    timeRef.current = time;
    useEffect(() => { if (!playing)
        return; let frame = 0; const begin = performance.now(), origin = timeRef.current; const tick = (now: number) => { const next = origin + (now - begin) / 1000; if (next >= range.sourceOut) {
        setPlaying(false);
        setTime(range.sourceOut);
        return;
    } setTime(next); seekRef.current(next); frame = requestAnimationFrame(tick); }; frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame); }, [playing, range.sourceOut]);
    useEffect(()=>{
        if(p.asset.kind!=="audio")return;
        void audioCallback.current?.(timeRef.current,playing).catch(()=>setPlaying(false));
        return ()=>{void audioCallback.current?.(timeRef.current,false);};
    },[playing,p.asset.kind]);
    const seek = (next:number) => {setPlaying(false);setTime(next);p.onSeek(next);};
    return <section className="source-monitor" aria-label="素材预览" onKeyDown={event => { if ((event.target as HTMLElement).matches("input,select,textarea"))
        return; if (event.key.toLowerCase() === "i") {
        event.preventDefault();
        p.onRange(Math.min(time, range.sourceOut - 1 / p.project.fps), range.sourceOut);
    } if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        p.onRange(range.sourceIn, Math.max(time, range.sourceIn + 1 / p.project.fps));
    } }}>
   <header><strong>{p.asset.name}</strong><button className="btn btn--quiet" onClick={p.onClose}>返回序列</button></header>
   <input aria-label="素材播放头" type="range" min="0" max={duration} step={1 / p.project.fps} value={time} onChange={event => seek(event.target.valueAsNumber)}/>
   <div className="source-monitor-tools"><button className="btn btn--quiet" disabled={p.asset.missing} onClick={() => { if (time >= range.sourceOut)
        seek(range.sourceIn); setPlaying(!playing); }}>{playing ? "暂停" : "试听 / 预览"}</button><span>{formatTimecode(time, p.project.fps)}</span><button className="btn btn--quiet" onClick={() => p.onRange(Math.min(time, range.sourceOut - 1 / p.project.fps), range.sourceOut)}>I</button><button className="btn btn--quiet" onClick={() => p.onRange(range.sourceIn, Math.max(time, range.sourceIn + 1 / p.project.fps))}>O</button><button className="btn btn--quiet" onClick={() => p.onRange(0, duration)}>重置</button><button className="btn btn--accent" disabled={p.asset.missing} onClick={p.onAdd}>加入时间线</button></div>
   <div className="source-range-fields" onFocusCapture={p.onBegin} onBlurCapture={p.onEnd}><label>入点<input type="number" min="0" max={range.sourceOut - 1 / p.project.fps} step={1 / p.project.fps} value={range.sourceIn} onChange={event => Number.isFinite(event.target.valueAsNumber) && p.onRange(Math.max(0, Math.min(range.sourceOut - 1 / p.project.fps, event.target.valueAsNumber)), range.sourceOut)}/></label><label>出点<input type="number" min={range.sourceIn + 1 / p.project.fps} max={duration} step={1 / p.project.fps} value={range.sourceOut} onChange={event => Number.isFinite(event.target.valueAsNumber) && p.onRange(range.sourceIn, Math.min(duration, Math.max(range.sourceIn + 1 / p.project.fps, event.target.valueAsNumber)))}/></label></div>
 </section>;
}

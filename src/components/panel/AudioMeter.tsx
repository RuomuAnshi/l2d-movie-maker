import { useEffect, useState } from "react";
import { gainToDb } from "../../sequence/properties";
export default function AudioMeter({ read }: {
    read: () => {
        peak: number;
        rms: number;
    };
}) {
    const [level, setLevel] = useState({ peak: 0, rms: 0 }), [clipped, setClipped] = useState(false);
    useEffect(() => { const timer = window.setInterval(() => { const value = read(); setLevel(value); if (value.peak >= 1)
        setClipped(true); }, 80); return () => clearInterval(timer); }, [read]);
    return <div className={`audio-meter${clipped ? " is-clipped" : ""}`} aria-label="主输出电平"><div className="audio-meter-bar" role="meter" aria-label="音频峰值" aria-valuemin={-60} aria-valuemax={6} aria-valuenow={gainToDb(level.peak)}><i style={{ width: `${Math.max(0, Math.min(100, (gainToDb(level.rms) + 60) / 60 * 100))}%` }}/><b style={{ left: `${Math.max(0, Math.min(100, (gainToDb(level.peak) + 60) / 60 * 100))}%` }}/></div><span>{level.peak ? gainToDb(level.peak).toFixed(1) : "−∞"} dB</span><button className="btn btn--quiet" aria-label="清除削波提示" onClick={() => setClipped(false)}>{clipped ? "削波" : "峰值"}</button></div>;
}

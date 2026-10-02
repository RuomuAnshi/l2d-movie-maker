import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listRecovery, readRecovery, type RecoveryEntry } from "../../utils/projectRecovery";
import type { ProjectSnapshot } from "../../utils/projectStorage";
export default function RecoveryDialog({ projectId, onRestore, onClose }: {
    projectId: string;
    onRestore: (snapshot: ProjectSnapshot) => Promise<void>;
    onClose: () => void;
}) {
    const [entries, setEntries] = useState<RecoveryEntry[]>([]), [issue, setIssue] = useState(""), [busy, setBusy] = useState(true);
    const [allProjects, setAllProjects] = useState(false);
    const closeButton=useRef<HTMLButtonElement>(null);
    useEffect(()=>{if(!busy)closeButton.current?.focus();},[busy]);
    useEffect(() => { let cancelled = false; setBusy(true); void listRecovery(allProjects ? undefined : projectId).then(value => { if (!cancelled)
        setEntries(value); }).catch(error => { if (!cancelled)
        setIssue(String(error)); }).finally(() => { if (!cancelled)
        setBusy(false); }); return () => { cancelled = true; }; }, [projectId, allProjects]);
    return createPortal(<div className="modal-overlay" onClick={() => !busy && onClose()} onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape" && !busy)
        onClose();
      if(event.key==="Tab") {
        const items=Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled)"));
        const index=items.indexOf(document.activeElement as HTMLElement);
        if((event.shiftKey&&index<=0)||(!event.shiftKey&&index===items.length-1)){event.preventDefault();items[event.shiftKey?items.length-1:0]?.focus();}
      }
    }}><section className="modal-box" role="dialog" aria-modal="true" aria-label="工程恢复" onClick={event => event.stopPropagation()}><h3>工程恢复</h3><label><input type="checkbox" checked={allProjects} onChange={event => setAllProjects(event.target.checked)}/>全部工程</label>{issue && <p role="alert">{issue}</p>}{!entries.length && <p>{busy ? "读取中…" : "暂无历史保存"}</p>}<div className="recovery-list">{entries.map(entry => <button className="btn btn--quiet" key={entry.path} disabled={busy} onClick={async () => { setBusy(true); try {
        await onRestore(await readRecovery(entry.path));
        onClose();
    }
    catch (error) {
        setIssue(String(error));
    }
    finally {
        setBusy(false);
    } }}>{entry.projectName} · {new Date(entry.savedAt).toLocaleString()}</button>)}</div><button ref={closeButton} className="btn btn--quiet" disabled={busy} onClick={onClose}>关闭</button></section></div>, document.body);
}

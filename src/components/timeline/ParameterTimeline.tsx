import { useRef, useState, useEffect } from "react";
import type { Clip, SubtitleClip, TrackKind } from "./clipTypes";
import {
  animationEnd,
  evaluateTrack,
  sortKeys,
  upsertKey,
  editSource,
} from "../../animation/engine";
import type {
  AnimationDocument,
  Keyframe,
  ParameterTrack,
  Interpolation,
} from "../../animation/types";
import "./parameters.css";
import NumberField from "./NumberField";
import { parseMaterialSource } from "../../sequence/materials";
import type { MaterialSource } from "../../sequence/materials";
type Props = {
  motionClips: Clip[];
  exprClips: Clip[];
  audioClips: Clip[];
  subtitleClips: SubtitleClip[];
  onImportMaterial: (
    name: string,
    kind: "motion" | "expression",
    start: number,
    source?: MaterialSource,
  ) => void;
  animation: AnimationDocument;
  onAnimationChange: (document: AnimationDocument) => void;
  onBeginEdit: () => void;
  onEndEdit: () => void;
  onUndo: () => void;
  onRedo: () => void;
  playheadSec: number;
  playheadSourceRef?: { current: number };
  onChangeClip: (
    track: TrackKind,
    id: string,
    patch: Partial<Pick<Clip, "start" | "duration">>,
  ) => void;
  onRemoveClip: (track: TrackKind, id: string) => void;
  onSetPlayhead?: (time: number) => void;
  onStartPlayback?: () => void;
  onStopPlayback?: () => void;
  isPlaying?: boolean;
};
type Selected = { target: string; id: string };
export default function Timeline(p: Props) {
  const [pps, setPps] = useState(80),
    [search, setSearch] = useState(""),
    [onlyAnimated, setOnlyAnimated] = useState(false),
    [graph, setGraph] = useState(false);
  const [selected, setSelected] = useState<Selected[]>([]),
    [focused, setFocused] = useState(""),
    [groupId, setGroupId] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const clipboard = useRef<{ target: string; key: Keyframe }[]>([]),
    area = useRef<HTMLDivElement>(null);
  const parameterElements = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (focused)
      parameterElements.current
        .get(focused)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [graph, focused, selected]);
  const document = p.animation;
  const previousGroupCount = useRef(0);
  useEffect(() => {
    if (!previousGroupCount.current && p.animation.groups.length)
      setOnlyAnimated(true);
    previousGroupCount.current = p.animation.groups.length;
  }, [p.animation.groups.length]);
  const length = Math.max(
    1,
    animationEnd(document),
    ...p.audioClips.map((c) => c.start + c.duration),
    ...p.subtitleClips.map((c) => c.start + c.duration),
  );
  const width = Math.max(960, (length + 1) * pps);
  const timeAt = (clientX: number) =>
    Math.max(
      0,
      (clientX -
        (area.current?.getBoundingClientRect().left ?? 0) +
        (area.current?.scrollLeft ?? 0)) /
        pps,
    );
  const updateTrack = (
    target: string,
    fn: (t: ParameterTrack) => ParameterTrack,
  ) =>
    p.onAnimationChange({
      ...document,
      tracks: document.tracks.map((t) =>
        t.definition.target === target ? fn(t) : t,
      ),
    });
  const continuousEdit = useRef(false);
  const beginContinuous = () => {
    if (!continuousEdit.current) {
      p.onBeginEdit();
      continuousEdit.current = true;
    }
  };
  const endContinuous = () => {
    if (continuousEdit.current) {
      p.onEndEdit();
      continuousEdit.current = false;
    }
  };
  const single = (fn: () => void) => {
    if (!continuousEdit.current) p.onBeginEdit();
    fn();
    if (!continuousEdit.current) p.onEndEdit();
  };
  const track = document.tracks.find((t) => t.definition.target === focused);
  const activeKey = track?.keys.find((k) =>
    selected.some((s) => s.target === focused && s.id === k.id),
  );
  const group = document.groups.find((g) => g.id === groupId);
  const keyPatch = (patch: Partial<Keyframe>) =>
    single(() => {
      const delta =
        patch.time === undefined ? 0 : patch.time - (activeKey?.time ?? 0);
      p.onAnimationChange({
        ...document,
        tracks: document.tracks.map((t) => ({
          ...t,
          keys: sortKeys(
            t.keys.map((k) =>
              selected.some(
                (s) => s.target === t.definition.target && s.id === k.id,
              )
                ? {
                    ...k,
                    ...patch,
                    time: Math.max(0, k.time + delta),
                    inHandle: k.inHandle && {
                      ...k.inHandle,
                      time: k.inHandle.time + delta,
                    },
                    outHandle: k.outHandle && {
                      ...k.outHandle,
                      time: k.outHandle.time + delta,
                    },
                  }
                : k,
            ),
          ),
        })),
      });
    });
  const remove = () =>
    single(() =>
      p.onAnimationChange({
        ...document,
        tracks: document.tracks.map((t) => ({
          ...t,
          keys: t.keys.filter(
            (k) =>
              !selected.some(
                (s) => s.target === t.definition.target && s.id === k.id,
              ),
          ),
        })),
      }),
    );
  const copy = () => {
    clipboard.current = document.tracks.flatMap((t) =>
      t.keys
        .filter((k) =>
          selected.some(
            (s) => s.target === t.definition.target && s.id === k.id,
          ),
        )
        .map((key) => ({
          target: t.definition.target,
          key: structuredClone(key),
        })),
    );
  };
  const paste = () =>
    single(() => {
      const earliest = Math.min(...clipboard.current.map((c) => c.key.time));
      if (!Number.isFinite(earliest)) return;
      const shift = p.playheadSec - earliest;
      p.onAnimationChange({
        ...document,
        tracks: document.tracks.map((t) => ({
          ...t,
          keys: sortKeys([
            ...t.keys,
            ...clipboard.current
              .filter((c) => c.target === t.definition.target)
              .map((c) => ({
                ...c.key,
                id: crypto.randomUUID(),
                sourceId: undefined,
                time: c.key.time + shift,
                inHandle: c.key.inHandle && {
                  ...c.key.inHandle,
                  time: c.key.inHandle.time + shift,
                },
                outHandle: c.key.outHandle && {
                  ...c.key.outHandle,
                  time: c.key.outHandle.time + shift,
                },
              })),
          ]),
        })),
      });
    });
  // Gestures always derive from the original document; one gesture is one history entry.
  const drag = (
    event: React.MouseEvent,
    move: (dx: number, dy: number) => void,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    (
      event.currentTarget.closest(".parameter-timeline") as HTMLElement | null
    )?.focus({ preventScroll: true });
    endContinuous();
    p.onBeginEdit();
    const x = event.clientX,
      y = event.clientY;
    const onMove = (e: MouseEvent) =>
      move((e.clientX - x) / pps, e.clientY - y);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      p.onEndEdit();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const moveKeys = (event: React.MouseEvent, target: string, key: Keyframe) => {
    const exists = selected.some((s) => s.target === target && s.id === key.id);
    const selection = event.shiftKey
      ? exists
        ? selected
        : selected.concat({ target, id: key.id })
      : exists
        ? selected
        : [{ target, id: key.id }];
    setSelected(selection);
    setFocused(target);
    setGroupId("");
    const original = document;
    const min = Math.min(
      ...original.tracks.flatMap((t) =>
        t.keys
          .filter((k) =>
            selection.some(
              (s) => s.target === t.definition.target && s.id === k.id,
            ),
          )
          .map((k) => k.time),
      ),
    );
    drag(event, (dx, dy) => {
      const shift = Math.max(-min, dx);
      p.onAnimationChange({
        ...original,
        tracks: original.tracks.map((t) => ({
          ...t,
          keys: sortKeys(
            t.keys.map((k) =>
              selection.some(
                (s) => s.target === t.definition.target && s.id === k.id,
              )
                ? {
                    ...k,
                    time: k.time + shift,
                    value: graph
                      ? Math.max(
                          t.definition.min,
                          Math.min(
                            t.definition.max,
                            k.value -
                              (dy * (t.definition.max - t.definition.min)) / 90,
                          ),
                        )
                      : k.value,
                    inHandle: k.inHandle && {
                      time: k.inHandle.time + shift,
                      value:
                        k.inHandle.value +
                        (graph
                          ? Math.max(
                              t.definition.min,
                              Math.min(
                                t.definition.max,
                                k.value -
                                  (dy * (t.definition.max - t.definition.min)) /
                                    90,
                              ),
                            ) - k.value
                          : 0),
                    },
                    outHandle: k.outHandle && {
                      time: k.outHandle.time + shift,
                      value:
                        k.outHandle.value +
                        (graph
                          ? Math.max(
                              t.definition.min,
                              Math.min(
                                t.definition.max,
                                k.value -
                                  (dy * (t.definition.max - t.definition.min)) /
                                    90,
                              ),
                            ) - k.value
                          : 0),
                    },
                  }
                : k,
            ),
          ),
        })),
      });
    });
  };
  const scrub = (event: React.MouseEvent) => {
    event.preventDefault();
    if (p.isPlaying) p.onStopPlayback?.();
    let latest = timeAt(event.clientX),
      raf = 0;
    const apply = () => {
      raf = 0;
      p.onSetPlayhead?.(latest);
    };
    p.onSetPlayhead?.(latest);
    const move = (e: MouseEvent) => {
      latest = timeAt(e.clientX);
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const up = () => {
      cancelAnimationFrame(raf);
      p.onSetPlayhead?.(latest);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const visualTime = p.playheadSec;
  const playheadElement = useRef<HTMLDivElement>(null);
  const timeElement = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const sync = (time: number) => {
      if (playheadElement.current)
        playheadElement.current.style.left = `${time * pps}px`;
      if (timeElement.current)
        timeElement.current.textContent = `${time.toFixed(2)} 秒`;
    };
    if (!p.isPlaying) {
      sync(p.playheadSec);
      return;
    }
    let raf = 0;
    const tick = () => {
      sync(p.playheadSourceRef?.current ?? p.playheadSec);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [p.isPlaying, p.playheadSec, p.playheadSourceRef, pps]);
  const tracks = document.tracks.filter(
    (t) =>
      (!onlyAnimated || t.animated) &&
      `${t.definition.name} ${t.definition.parameterId}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const rows: (
    | { type: "heading"; id: string; name: string }
    | { type: "parameter"; track: ParameterTrack }
  )[] = [];
  const characters = [...new Set(tracks.map((t) => t.definition.characterId))];
  for (const character of characters) {
    rows.push({
      type: "heading",
      id: character,
      name: character === "main" ? "角色" : character,
    });
    if (collapsed.has(character)) continue;
    const partCount = new Set(tracks.filter(t => t.definition.characterId === character).map(t => t.definition.partId)).size;
    const groupLabel = (t: ParameterTrack) => partCount > 1 ? `${t.definition.group} · 部件 ${t.definition.partId}` : t.definition.group;
    const groups = [
      ...new Set(
        tracks
          .filter((t) => t.definition.characterId === character)
          .map(groupLabel),
      ),
    ];
    for (const g of groups) {
      const id = `${character}/${g}`;
      rows.push({ type: "heading", id, name: g });
      if (!collapsed.has(id))
        rows.push(
          ...tracks
            .filter(
              (t) =>
                t.definition.characterId === character &&
                groupLabel(t) === g,
            )
            .map((track) => ({ type: "parameter" as const, track })),
        );
    }
  }
  const height = (r: (typeof rows)[number]) =>
    r.type === "heading"
      ? 26
      : graph && r.track.definition.target === focused
        ? 110
        : 30;
  const yValue = (t: ParameterTrack, v: number) =>
    100 -
    (90 * (v - t.definition.min)) /
      Math.max(1e-6, t.definition.max - t.definition.min);
  const media = [
    { kind: "audio" as const, clips: p.audioClips, label: "音频" },
    { kind: "subtitle" as const, clips: p.subtitleClips, label: "字幕" },
  ];
  return (
    <div
      className="tl-root parameter-timeline"
      role="region"
      aria-label="参数时间线"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).matches("input,select")) return;
        const command = e.metaKey || e.ctrlKey;
        if (command && e.key === "z") {
          e.preventDefault();
          if (e.shiftKey) p.onRedo();
          else p.onUndo();
        }
        if (command && e.key === "c") {
          e.preventDefault();
          copy();
        }
        if (command && e.key === "v") {
          e.preventDefault();
          paste();
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          remove();
        }
      }}
    >
      <div className="tl-header">
        <strong>时间线</strong>
        <div className="tl-toolbar">
          <button
            className="btn btn--quiet"
            onClick={() =>
              p.isPlaying ? p.onStopPlayback?.() : p.onStartPlayback?.()
            }
          >
            {p.isPlaying ? "暂停" : "播放"}
          </button>
          <button className="btn btn--quiet" onClick={p.onUndo}>
            撤销
          </button>
          <button className="btn btn--quiet" onClick={p.onRedo}>
            重做
          </button>
          <input
            aria-label="搜索参数"
            placeholder="搜索参数"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label>
            <input
              type="checkbox"
              checked={onlyAnimated}
              onChange={(e) => setOnlyAnimated(e.target.checked)}
            />
            已动画
          </label>
          <button className="btn btn--quiet" onClick={() => setGraph(!graph)}>
            {graph ? "关键帧" : "曲线"}
          </button>
          <button
            className="btn btn--quiet"
            onClick={() => setPps(Math.max(10, pps / 1.25))}
          >
            −
          </button>
          <button
            className="btn btn--quiet"
            onClick={() => setPps(Math.min(800, pps * 1.25))}
          >
            ＋
          </button>
          <span ref={timeElement}>{visualTime.toFixed(2)} 秒</span>
        </div>
      </div>
      {(track || group) && (
        <div className="parameter-inspector">
          {track && (
            <>
              <strong>{track.definition.name}</strong>
              <NumberField
                aria-label="参数值"
                step="0.01"
                min={track.definition.min}
                max={track.definition.max}
                value={Number(
                  (
                    activeKey?.value ?? evaluateTrack(track, p.playheadSec)
                  ).toFixed(4),
                )}
                onBegin={beginContinuous}
                onEnd={endContinuous}
                onChange={(value) =>
                  activeKey
                    ? keyPatch({ value: value })
                    : single(() =>
                        updateTrack(focused, (t) =>
                          t.animated
                            ? upsertKey(t, p.playheadSec, value)
                            : { ...t, baseValue: value },
                        ),
                      )
                }
              />
              <button
                className="btn btn--quiet"
                onClick={() =>
                  single(() =>
                    updateTrack(focused, (t) =>
                      upsertKey(
                        t,
                        p.playheadSec,
                        evaluateTrack(t, p.playheadSec),
                      ),
                    ),
                  )
                }
              >
                打帧
              </button>
              <button
                className="btn btn--quiet"
                onClick={() =>
                  single(() =>
                    updateTrack(focused, (t) => ({
                      ...t,
                      baseValue: t.definition.defaultValue,
                      animated: false,
                      keys: [],
                    })),
                  )
                }
              >
                恢复默认
              </button>
              {activeKey && (
                <>
                  <NumberField
                    aria-label="关键帧时间"
                    min="0"
                    step="0.001"
                    value={activeKey.time}
                    onBegin={beginContinuous}
                    onEnd={endContinuous}
                    onChange={(value) => keyPatch({ time: Math.max(0, value) })}
                  />
                  <select
                    aria-label="插值"
                    value={activeKey.interpolation}
                    onChange={(e) =>
                      keyPatch({
                        interpolation: e.target.value as Interpolation,
                      })
                    }
                  >
                    <option value="linear">线性</option>
                    <option value="hold">保持</option>
                    <option value="inverse-hold">逆保持</option>
                    <option value="bezier">贝塞尔</option>
                  </select>
                  <button className="btn btn--quiet" onClick={remove}>
                    删除帧
                  </button>
                  <button className="btn btn--quiet" onClick={copy}>
                    复制
                  </button>
                  <button className="btn btn--quiet" onClick={paste}>
                    粘贴
                  </button>
                </>
              )}
            </>
          )}
          {group && (
            <>
              <strong>{group.name}</strong>
              <label>
                速度{" "}
                <NumberField
                  aria-label="素材速度"
                  min="0.05"
                  step="0.1"
                  value={group.speed}
                  onBegin={beginContinuous}
                  onEnd={endContinuous}
                  onChange={(value) => {
                    const speed = Math.max(0.05, value);
                    single(() =>
                      p.onAnimationChange(
                        editSource(document, group.id, {
                          speed,
                          duration: (group.duration * group.speed) / speed,
                        }),
                      ),
                    );
                  }}
                />
              </label>
              <button
                className="btn btn--quiet"
                onClick={() =>
                  single(() =>
                    p.onAnimationChange(
                      editSource(document, group.id, {
                        offset: 0,
                        duration: group.sourceDuration / group.speed,
                      }),
                    ),
                  )
                }
              >
                恢复裁剪
              </button>
              <button
                className="btn btn--quiet"
                onClick={() =>
                  single(() =>
                    p.onAnimationChange({
                      ...document,
                      groups: document.groups.filter((g) => g.id !== group.id),
                      tracks: document.tracks.map((t) => ({
                        ...t,
                        keys: t.keys.filter((k) => k.sourceId !== group.id),
                      })),
                    }),
                  )
                }
              >
                删除分组
              </button>
            </>
          )}
        </div>
      )}
      <div className="parameter-scroll">
        <div className="tl-layout">
          <div className="tl-side parameter-side">
            <div style={{ height: 30 }} />
            <div style={{ height: 32 }}>素材</div>
            {rows.map((r) => (
              <div
                key={r.type === "heading" ? r.id : r.track.definition.target}
                style={{ height: height(r) }}
                className="parameter-label"
              >
                {r.type === "heading" ? (
                  <button
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(r.id)) next.delete(r.id);
                        else next.add(r.id);
                        return next;
                      })
                    }
                  >
                    {collapsed.has(r.id) ? "▸" : "▾"} {r.name}
                  </button>
                ) : (
                  <>
                    <input
                      aria-label={`${r.track.definition.name}动画`}
                      type="checkbox"
                      checked={r.track.animated}
                      onChange={(e) =>
                        single(() =>
                          updateTrack(r.track.definition.target, (t) => ({
                            ...t,
                            animated: e.target.checked,
                          })),
                        )
                      }
                    />
                    <button
                      title={`${r.track.definition.parameterId} · ${r.track.definition.min}～${r.track.definition.max}`}
                      onClick={() => {
                        setFocused(r.track.definition.target);
                        setGroupId("");
                      }}
                    >
                      {r.track.definition.name}
                    </button>
                    <output>
                      {evaluateTrack(r.track, p.playheadSec).toFixed(2)}
                    </output>
                    <input
                      aria-label={r.track.definition.name}
                      type="range"
                      min={r.track.definition.min}
                      max={r.track.definition.max}
                      step={
                        (r.track.definition.max - r.track.definition.min) / 1000
                      }
                      value={evaluateTrack(r.track, p.playheadSec)}
                      onPointerDown={beginContinuous}
                      onPointerUp={endContinuous}
                      onBlur={endContinuous}
                      onPointerCancel={endContinuous}
                      onKeyDown={(event) => {
                        if (
                          [
                            "ArrowLeft",
                            "ArrowRight",
                            "ArrowUp",
                            "ArrowDown",
                            "Home",
                            "End",
                          ].includes(event.key)
                        )
                          beginContinuous();
                      }}
                      onKeyUp={endContinuous}
                      onChange={(e) =>
                        single(() =>
                          updateTrack(r.track.definition.target, (t) =>
                            t.animated
                              ? upsertKey(
                                  t,
                                  p.playheadSec,
                                  Number(e.target.value),
                                )
                              : { ...t, baseValue: Number(e.target.value) },
                          ),
                        )
                      }
                    />
                  </>
                )}
              </div>
            ))}
            {media.map((m) => (
              <div key={m.kind} style={{ height: 36 }}>
                {m.label}
              </div>
            ))}
          </div>
          <div
            className="tl-timearea"
            ref={area}
            onDragOver={(e) => {
              if (
                e.dataTransfer.types.includes("application/x-live2d-material")
              )
                e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              try {
                const material = JSON.parse(
                  e.dataTransfer.getData("application/x-live2d-material"),
                );
                if (
                  typeof material.name === "string" &&
                  ["motion", "expression"].includes(material.kind)
                )
                  p.onImportMaterial(
                    material.name,
                    material.kind,
                    timeAt(e.clientX),
                    material.source ? parseMaterialSource(material.source) : undefined,
                  );
              } catch (error) {
                window.alert(error instanceof Error ? error.message : "无法导入该素材。");
              }
            }}
          >
            <div style={{ width, position: "relative" }}>
              <div
                className="parameter-ruler"
                style={{ height: 30 }}
                onMouseDown={scrub}
              >
                {Array.from({ length: Math.ceil(width / pps) }, (_, i) => (
                  <span key={i} style={{ left: i * pps }}>
                    {i}s
                  </span>
                ))}
              </div>
              <div className="parameter-lane" style={{ height: 32 }}>
                {document.groups.map((g) => (
                  <div
                    key={g.id}
                    className="parameter-source"
                    style={{ left: g.start * pps, width: g.duration * pps }}
                    onMouseDown={(e) => {
                      setGroupId(g.id);
                      setFocused("");
                      drag(e, (dx) =>
                        p.onAnimationChange(
                          editSource(document, g.id, {
                            start: Math.max(0, g.start + dx),
                          }),
                        ),
                      );
                    }}
                  >
                    <span
                      className="parameter-edge"
                      onMouseDown={(e) =>
                        drag(e, (dx) => {
                          const shift = Math.max(
                            -g.start,
                            Math.min(g.duration - 0.01, dx),
                          );
                          p.onAnimationChange(
                            editSource(document, g.id, {
                              start: g.start + shift,
                              offset: Math.max(0, g.offset + shift * g.speed),
                              duration: g.duration - shift,
                            }),
                          );
                        })
                      }
                    />
                    {g.name}
                    <span
                      className="parameter-edge right"
                      onMouseDown={(e) =>
                        drag(e, (dx) =>
                          p.onAnimationChange(
                            editSource(document, g.id, {
                              duration: Math.max(0.01, g.duration + dx),
                            }),
                          ),
                        )
                      }
                    />
                  </div>
                ))}
              </div>
              {rows.map((r) =>
                r.type === "heading" ? (
                  <div
                    key={r.id}
                    className="parameter-lane heading"
                    style={{ height: 26 }}
                  />
                ) : (
                  <div
                    key={r.track.definition.target}
                    ref={(element) => {
                      if (element)
                        parameterElements.current.set(
                          r.track.definition.target,
                          element,
                        );
                      else
                        parameterElements.current.delete(
                          r.track.definition.target,
                        );
                    }}
                    className="parameter-lane"
                    style={{ height: height(r) }}
                    onDoubleClick={(e) => {
                      const t = timeAt(e.clientX);
                      single(() =>
                        updateTrack(r.track.definition.target, (track) =>
                          upsertKey(track, t, evaluateTrack(track, t)),
                        ),
                      );
                    }}
                  >
                    {graph && focused === r.track.definition.target && (
                      <svg width={width} height={110}>
                        <polyline
                          fill="none"
                          stroke="#708a4b"
                          strokeWidth={2}
                          points={Array.from(
                            { length: Math.ceil(width / 4) },
                            (_, i) =>
                              `${i * 4},${yValue(r.track, evaluateTrack(r.track, (i * 4) / pps))}`,
                          ).join(" ")}
                        />
                        {r.track.keys
                          .filter((k) => selected.some((s) => s.id === k.id))
                          .flatMap((k) =>
                            (["inHandle", "outHandle"] as const).map(
                              (which) => {
                                const handle = k[which] ?? {
                                  time:
                                    k.time +
                                    (which === "inHandle" ? -0.2 : 0.2),
                                  value: k.value,
                                };
                                return (
                                  <g key={k.id + which}>
                                    <line
                                      x1={k.time * pps}
                                      y1={yValue(r.track, k.value)}
                                      x2={handle.time * pps}
                                      y2={yValue(r.track, handle.value)}
                                      stroke="#ad6551"
                                    />
                                    <circle
                                      cx={handle.time * pps}
                                      cy={yValue(r.track, handle.value)}
                                      r={4}
                                      fill="#ad6551"
                                      onMouseDown={(e) =>
                                        drag(e, (dx, dy) =>
                                          updateTrack(
                                            r.track.definition.target,
                                            (t) => ({
                                              ...t,
                                              keys: t.keys.map(
                                                (candidate, index) =>
                                                  candidate.id === k.id
                                                    ? {
                                                        ...candidate,
                                                        interpolation:
                                                          which === "outHandle"
                                                            ? "bezier"
                                                            : candidate.interpolation,
                                                        [which]: {
                                                          time:
                                                            handle.time + dx,
                                                          value:
                                                            handle.value -
                                                            (dy *
                                                              (t.definition
                                                                .max -
                                                                t.definition
                                                                  .min)) /
                                                              90,
                                                        },
                                                      }
                                                    : which === "inHandle" &&
                                                        t.keys[index + 1]
                                                          ?.id === k.id
                                                      ? {
                                                          ...candidate,
                                                          interpolation:
                                                            "bezier",
                                                        }
                                                      : candidate,
                                              ),
                                            }),
                                          ),
                                        )
                                      }
                                    />
                                  </g>
                                );
                              },
                            ),
                          )}
                      </svg>
                    )}
                    {r.track.keys.map((k) => (
                      <button
                        key={k.id}
                        title={`${k.time.toFixed(3)}s · ${k.value.toFixed(3)}`}
                        aria-label="关键帧"
                        className={`parameter-key ${selected.some((s) => s.id === k.id) ? "selected" : ""}`}
                        style={{
                          left: k.time * pps,
                          top:
                            graph && focused === r.track.definition.target
                              ? yValue(r.track, k.value)
                              : 15,
                        }}
                        onMouseDown={(e) =>
                          moveKeys(e, r.track.definition.target, k)
                        }
                      />
                    ))}
                  </div>
                ),
              )}
              {media.map((m) => (
                <div
                  key={m.kind}
                  className="parameter-lane"
                  style={{ height: 36 }}
                >
                  {m.clips.map((c) => (
                    <div
                      key={c.id}
                      className={`parameter-source ${m.kind}`}
                      style={{
                        left: c.start * pps,
                        width: Math.max(24, c.duration * pps),
                      }}
                      onMouseDown={(e) =>
                        drag(e, (dx) =>
                          p.onChangeClip(m.kind, c.id, {
                            start: Math.max(0, c.start + dx),
                          }),
                        )
                      }
                    >
                      <span
                        className="parameter-edge"
                        onMouseDown={(e) =>
                          drag(e, (dx) => {
                            const shift = Math.max(
                              -c.start,
                              Math.min(c.duration - 0.1, dx),
                            );
                            p.onChangeClip(m.kind, c.id, {
                              start: c.start + shift,
                              duration: c.duration - shift,
                            });
                          })
                        }
                      />
                      {m.kind === "audio" && c.waveformPeaks && (
                        <div className="parameter-waveform" aria-hidden="true">
                          {c.waveformPeaks.map((peak, i) => (
                            <i
                              key={i}
                              style={{ height: `${Math.max(8, peak * 100)}%` }}
                            />
                          ))}
                        </div>
                      )}
                      {c.name}
                      <button
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() =>
                          single(() => p.onRemoveClip(m.kind, c.id))
                        }
                      >
                        ×
                      </button>
                      <span
                        className="parameter-edge right"
                        onMouseDown={(e) =>
                          drag(e, (dx) =>
                            p.onChangeClip(m.kind, c.id, {
                              duration: Math.max(0.1, c.duration + dx),
                            }),
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
              ))}
              <div
                ref={playheadElement}
                className="parameter-playhead"
                style={{ left: visualTime * pps }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import type { InputHTMLAttributes } from "react";
type Props = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "onFocus" | "onBlur"
> & {
  value: number;
  onChange: (value: number) => void;
  onBegin: () => void;
  onEnd: () => void;
};
/** Keep an empty typing draft out of the animation data and commit one edit on blur. */
export default function NumberField({
  value,
  onChange,
  onBegin,
  onEnd,
  ...props
}: Props) {
  const [draft, setDraft] = useState(String(value)),
    [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);
  return (
    <input
      {...props}
      type="number"
      value={draft}
      onFocus={() => {
        setEditing(true);
        onBegin();
      }}
      onBlur={() => {
        setEditing(false);
        setDraft(String(value));
        onEnd();
      }}
      onChange={(event) => {
        setDraft(event.target.value);
        if (
          event.target.value.trim() &&
          Number.isFinite(Number(event.target.value))
        )
          onChange(Number(event.target.value));
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

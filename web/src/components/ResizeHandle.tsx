import type { KeyboardEvent, PointerEvent } from 'react';

/** The drag handle the sidebar and the panels on the right share: a separator, dragged, keyed, double-clicked to reset. */
export function ResizeHandle(props: {
  orientation: 'vertical' | 'horizontal';
  className?: string;
  label: string;
  value?: number;
  min?: number;
  max?: number;
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerEnd?: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  onReset: () => void;
}) {
  return (
    <div
      className={`sidebar-resizer ${props.orientation}${props.className ? ` ${props.className}` : ''}`}
      role="separator"
      aria-label={props.label}
      aria-orientation={props.orientation}
      aria-valuenow={props.value}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerEnd}
      onPointerCancel={props.onPointerEnd}
      onDoubleClick={props.onReset}
      onKeyDown={props.onKeyDown}
    />
  );
}

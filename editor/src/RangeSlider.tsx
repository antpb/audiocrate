import type { PointerEvent, InputHTMLAttributes } from 'react';

/**
 * A range that keeps the drag. Parent scrollers (the inspector sheet) must
 * not steal the pointer once the thumb is down.
 */
export function RangeSlider(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className, onPointerDown, ...rest } = props;
  return (
    <input
      {...rest}
      type="range"
      className={`range-latch${className ? ` ${className}` : ''}`}
      onPointerDown={(event: PointerEvent<HTMLInputElement>) => {
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        onPointerDown?.(event);
      }}
    />
  );
}

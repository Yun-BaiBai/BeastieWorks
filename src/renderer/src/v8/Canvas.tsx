import { useLayoutEffect, useRef, type ReactNode } from 'react';

export const CANVAS_W = 1440;
export const CANVAS_H = 920;

/**
 * One fixed 1440×920 screen, scaled as a whole to fit the window and centred. Every v8 page is laid out in these
 * canvas pixels, the same numbers as the prototype, so nothing reflows and nothing scrolls.
 */
export function Canvas({ children, label }: { children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const el = ref.current;
      if (!el) return;
      const scale = Math.min(window.innerWidth / CANVAS_W, window.innerHeight / CANVAS_H);
      el.style.transform = `translateX(-50%) scale(${scale})`;
      el.style.top = Math.max(0, (window.innerHeight - CANVAS_H * scale) / 2) + 'px';
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return <div ref={ref} className="v8-canvas" role="main" aria-label={label}>{children}</div>;
}

import { scopeHue } from "../observe/session-model.js";

/**
 * A job's colour (`13`, *In-game UI*, "Colours"): `#rrggbb`, lowercase, a function of the job id
 * alone, so it stays the same for the job's life, across resyncs and in replay. The hue is the one
 * the browser viewer used for the same scope (`scopeHue`), at a saturation and lightness that read
 * against both daylight terrain and night.
 */
export function jobColour(id: string): string {
  return hsl(scopeHue(id), 0.75, 0.55);
}

function hsl(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

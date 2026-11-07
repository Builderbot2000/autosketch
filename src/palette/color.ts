/** sRGB ↔ CIELAB (D65) and derived perceptual measures. */

export type RGB = [number, number, number]; // 0–255
export type Lab = [number, number, number]; // L 0–100, a/b roughly ±128

const toLinear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c: number) => {
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
};

const Xn = 0.95047;
const Yn = 1.0;
const Zn = 1.08883;
const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const finv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));

export function rgbToLab([r, g, b]: RGB): Lab {
  const R = toLinear(r);
  const G = toLinear(g);
  const B = toLinear(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / Xn;
  const Y = (0.2126729 * R + 0.7151522 * G + 0.072175 * B) / Yn;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / Zn;
  const fy = f(Y);
  return [116 * fy - 16, 500 * (f(X) - fy), 200 * (fy - f(Z))];
}

export function labToRgb([L, a, b]: Lab): RGB {
  const fy = (L + 16) / 116;
  const X = finv(fy + a / 500) * Xn;
  const Y = finv(fy) * Yn;
  const Z = finv(fy - b / 200) * Zn;
  const R = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const G = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  const B = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  return [fromLinear(R), fromLinear(G), fromLinear(B)];
}

export const chroma = ([, a, b]: Lab) => Math.hypot(a, b);
/** Hue angle in degrees 0–360 (CIELAB hab). */
export const hue = ([, a, b]: Lab) => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
export const deltaE = (p: Lab, q: Lab) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

export function hexToRgb(hex: string): RGB {
  const h = hex.replace(/^#/, "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = ([r, g, b]: RGB) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

/** Coarse human-readable colour name, for captions and text summaries. */
export function colorName(lab: Lab): string {
  const [L] = lab;
  const C = chroma(lab);
  const tone = L < 25 ? "dark " : L > 75 ? "light " : "";
  if (C < 10) return L < 20 ? "black" : L > 85 ? "white" : `${tone}grey`;
  const h = hue(lab);
  const names: [number, string][] = [
    [20, "pink-red"], [45, "red"], [70, "orange"], [85, "tan"], [105, "yellow"],
    [150, "olive-green"], [200, "green"], [245, "teal"], [308, "blue"], [338, "purple"], [360, "magenta"],
  ];
  let name = "red";
  for (const [lim, n] of names) if (h < lim) { name = n; break; }
  if ((name === "orange" || name === "tan" || name === "red") && (C < 22 || (L < 45 && C < 40))) name = "brown";
  return `${tone}${name}`;
}

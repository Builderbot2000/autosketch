// WebGL view of a voxel grid with box overlays (docs/design/12-observability.md, panel 1).
//
// Raw WebGL 1: three.js is not in the repository's node_modules and nothing is fetched, so the
// view draws the baked models itself. One vertex buffer pair (opaque, blended) per 16³ chunk,
// rebuilt only for dirty chunks. Overlays are coloured lines and translucent boxes in a second
// program, rebuilt each frame (there are few). Labels are HTML elements positioned by `project`.

import { meshChunk, fallbackModel, STRIDE } from "./voxels.js";

const VS = `
attribute vec3 aPos; attribute vec2 aUv; attribute vec4 aCol;
uniform mat4 uMvp; varying vec2 vUv; varying vec4 vCol;
void main() { gl_Position = uMvp * vec4(aPos, 1.0); vUv = aUv; vCol = aCol; }`;
const FS = `
precision mediump float; uniform sampler2D uTex; uniform float uAlphaCut;
varying vec2 vUv; varying vec4 vCol;
void main() {
  vec4 t = vUv.x < 0.0 ? vec4(1.0) : texture2D(uTex, vUv);
  if (vCol.a < 1.0) { float l = dot(t.rgb, vec3(0.3, 0.59, 0.11)); t.rgb = vec3(l); }
  vec4 c = vec4(t.rgb * vCol.rgb, t.a * vCol.a);
  if (c.a < uAlphaCut) discard;
  gl_FragColor = c;
}`;
const LVS = `
attribute vec3 aPos; attribute vec4 aCol; uniform mat4 uMvp; varying vec4 vCol;
void main() { gl_Position = uMvp * vec4(aPos, 1.0); vCol = aCol; }`;
const LFS = `precision mediump float; varying vec4 vCol; void main() { gl_FragColor = vCol; }`;

export class VoxelView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import("./voxels.js").VoxelGrid} grid
   */
  constructor(canvas, grid) {
    this.canvas = canvas;
    this.grid = grid;
    const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
    if (!gl) throw new Error("WebGL is not available in this browser");
    this.gl = gl;
    this.prog = program(gl, VS, FS);
    this.lprog = program(gl, LVS, LFS);
    this.meshes = new Map();
    this.models = {};
    this.states = new Map();
    this.fallbacks = new Map();
    this.atlasSize = [1, 1];
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    this.lineBuf = gl.createBuffer();
    this.triBuf = gl.createBuffer();
    /** Overlay boxes: { box, color: [r,g,b,a], fill?: alpha, until?: ms } (inclusive boxes). */
    this.overlays = [];
    this.flashes = [];
    /** Marks context voxels as ghosts (drill-in); undefined for none. */
    this.ghost = undefined;
    this.cam = { target: [0, 0, 0], yaw: Math.PI * 0.75, pitch: 0.6, dist: 40 };
    this.needsDraw = true;
    this.onFrame = null;
    this.attachControls();
    const loop = () => {
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  /** Baked models by state id (from /assets/models.json) and the state names (for fallbacks). */
  setModels(models, states) {
    this.models = models || {};
    this.states = states;
    this.fallbacks.clear();
    this.remeshAll();
  }

  setAtlas(img) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.atlasSize = [img.naturalWidth || img.width, img.naturalHeight || img.height];
    this.remeshAll();
  }

  remeshAll() {
    for (const k of this.grid.chunks.keys()) this.grid.dirty.add(k);
    for (const k of this.meshes.keys()) this.grid.dirty.add(k);
    this.needsDraw = true;
  }

  modelFor = (id) => {
    const m = this.models[id];
    if (m && !m.fb) return m;
    let f = this.fallbacks.get(id);
    if (!f) this.fallbacks.set(id, (f = fallbackModel(this.states.get(id))));
    return f;
  };

  /** Points the camera at an inclusive box. */
  fit(box) {
    if (!box) return;
    const c = [0, 1, 2].map((i) => (box.min[i] + box.max[i] + 1) / 2);
    const size = Math.max(...[0, 1, 2].map((i) => box.max[i] - box.min[i] + 1));
    this.cam.target = c;
    this.cam.dist = Math.max(8, size * 1.8);
    this.needsDraw = true;
  }

  /** Briefly highlights a changed box (12: recently changed blocks). */
  flash(box, color = [1, 0.85, 0.2]) {
    this.flashes.push({ box, color, until: performance.now() + 1500 });
    this.needsDraw = true;
  }

  /** Screen position (CSS px) of a world point, or null when behind the camera. */
  project(p) {
    const m = this.mvp;
    if (!m) return null;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (w <= 0) return null;
    const r = this.canvas.getBoundingClientRect();
    return [((x / w) * 0.5 + 0.5) * r.width, (1 - ((y / w) * 0.5 + 0.5)) * r.height];
  }

  frame() {
    const now = performance.now();
    this.flashes = this.flashes.filter((f) => f.until > now);
    const dirty = this.grid.dirty.size > 0;
    if (!dirty && !this.needsDraw && !this.flashes.length && !this.resized()) return;
    this.needsDraw = false;
    const gl = this.gl;
    // Remesh dirty chunks (bounded per frame so a big snapshot doesn't freeze the page).
    let budget = 64;
    for (const k of this.grid.dirty) {
      if (budget-- <= 0) break;
      this.grid.dirty.delete(k);
      this.upload(k, meshChunk(this.grid, k, this.modelFor, this.atlasSize, this.ghost));
    }
    if (this.grid.dirty.size) this.needsDraw = true;

    const w = this.canvas.width, h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.11, 0.12, 0.14, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    this.mvp = this.matrix(w / Math.max(1, h));

    gl.useProgram(this.prog.p);
    gl.uniformMatrix4fv(this.prog.u.uMvp, false, this.mvp);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.uniform1f(this.prog.u.uAlphaCut, 0.5);
    for (const m of this.meshes.values()) this.drawMesh(m.opaque);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.uniform1f(this.prog.u.uAlphaCut, 0.02);
    for (const m of this.meshes.values()) this.drawMesh(m.blend);

    this.drawOverlays(now);
    gl.depthMask(true);
    this.onFrame?.();
  }

  resized() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    return true;
  }

  upload(key, mesh) {
    const gl = this.gl;
    let m = this.meshes.get(key);
    if (!mesh.opaque.length && !mesh.blend.length) {
      if (m) {
        gl.deleteBuffer(m.opaque.buf);
        gl.deleteBuffer(m.blend.buf);
        this.meshes.delete(key);
      }
      return;
    }
    if (!m) this.meshes.set(key, (m = { opaque: { buf: gl.createBuffer(), n: 0 }, blend: { buf: gl.createBuffer(), n: 0 } }));
    for (const part of ["opaque", "blend"]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, m[part].buf);
      gl.bufferData(gl.ARRAY_BUFFER, mesh[part], gl.STATIC_DRAW);
      m[part].n = mesh[part].length / STRIDE;
    }
  }

  drawMesh(part) {
    if (!part.n) return;
    const gl = this.gl, a = this.prog.a;
    gl.bindBuffer(gl.ARRAY_BUFFER, part.buf);
    gl.enableVertexAttribArray(a.aPos);
    gl.vertexAttribPointer(a.aPos, 3, gl.FLOAT, false, STRIDE * 4, 0);
    gl.enableVertexAttribArray(a.aUv);
    gl.vertexAttribPointer(a.aUv, 2, gl.FLOAT, false, STRIDE * 4, 12);
    gl.enableVertexAttribArray(a.aCol);
    gl.vertexAttribPointer(a.aCol, 4, gl.FLOAT, false, STRIDE * 4, 20);
    gl.drawArrays(gl.TRIANGLES, 0, part.n);
  }

  drawOverlays(now) {
    const lines = [], tris = [];
    const all = [...this.overlays, ...this.flashes.map((f) => ({ box: f.box, color: [...f.color, Math.max(0, (f.until - now) / 1500)], width: 1 }))];
    for (const o of all) {
      const [x0, y0, z0] = o.box.min.map((v) => v - 0.02), [x1, y1, z1] = o.box.max.map((v) => v + 1.02);
      const col = o.color.length === 4 ? o.color : [...o.color, 1];
      const c = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
      for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) lines.push(...c[a], ...col, ...c[b], ...col);
      if (o.fill) {
        const fc = [col[0], col[1], col[2], o.fill];
        for (const f of [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]])
          for (const i of [0, 1, 2, 0, 2, 3]) tris.push(...c[f[i]], ...fc);
      }
    }
    if (!lines.length) return;
    const gl = this.gl, a = this.lprog.a;
    gl.useProgram(this.lprog.p);
    gl.uniformMatrix4fv(this.lprog.u.uMvp, false, this.mvp);
    const draw = (buf, data, mode) => {
      if (!data.length) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(a.aPos);
      gl.vertexAttribPointer(a.aPos, 3, gl.FLOAT, false, 28, 0);
      gl.enableVertexAttribArray(a.aCol);
      gl.vertexAttribPointer(a.aCol, 4, gl.FLOAT, false, 28, 12);
      gl.drawArrays(mode, 0, data.length / 7);
    };
    draw(this.triBuf, tris, gl.TRIANGLES);
    gl.disable(gl.DEPTH_TEST); // lock outlines stay visible through blocks
    draw(this.lineBuf, lines, gl.LINES);
    gl.enable(gl.DEPTH_TEST);
  }

  matrix(aspect) {
    const { target, yaw, pitch, dist } = this.cam;
    const eye = [target[0] + dist * Math.cos(pitch) * Math.sin(yaw), target[1] + dist * Math.sin(pitch), target[2] + dist * Math.cos(pitch) * Math.cos(yaw)];
    return mul(perspective(0.9, aspect, Math.max(0.1, dist / 200), dist * 20 + 1000), lookAt(eye, target, [0, 1, 0]));
  }

  attachControls() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointerup", () => (drag = null));
    c.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      const cam = this.cam;
      if (drag.pan) {
        const s = cam.dist / 600;
        const right = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)];
        cam.target = [cam.target[0] - right[0] * dx * s, cam.target[1] + dy * s, cam.target[2] - right[2] * dx * s];
      } else {
        cam.yaw -= dx * 0.008;
        cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch + dy * 0.008));
      }
      this.needsDraw = true;
    });
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.cam.dist = Math.max(2, this.cam.dist * Math.exp(e.deltaY * 0.001));
      this.needsDraw = true;
    }, { passive: false });
  }
}

function program(gl, vs, fs) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const a = {}, u = {};
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES); i++) {
    const n = gl.getActiveAttrib(p, i).name;
    a[n] = gl.getAttribLocation(p, n);
  }
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
    const n = gl.getActiveUniform(p, i).name;
    u[n] = gl.getUniformLocation(p, n);
  }
  return { p, a, u };
}

// Column-major 4×4 matrices, as WebGL expects.
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

function lookAt(eye, at, up) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (v) => {
    const l = Math.hypot(...v) || 1;
    return v.map((x) => x / l);
  };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, at)), x = norm(cross(up, z)), y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

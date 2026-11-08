// three.js view of a voxel grid with box overlays (docs/design/12-observability.md, panel 1).
//
// three.js is served from the installed package (`/vendor/three/`, see src/observe/http.ts) and
// found through the page's import map; nothing is bundled or fetched from elsewhere. Meshing stays
// in voxels.js (pure, tested in Node): one opaque mesh (alpha-tested) and one blended mesh per 16³
// chunk, rebuilt only for dirty chunks, from the instance's baked models and atlas or flat colour
// cubes without an instance. Overlays (work volumes, context wireframes, change flashes) are
// rebuilt when drawn (there are few). Labels are HTML elements positioned by `project`.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { meshChunk, fallbackModel, STRIDE } from "./voxels.js";

// Colours are used as given, the way the rasterizer and the baked models define them.
THREE.ColorManagement.enabled = false;

const VS = `
attribute vec4 aCol;
varying vec2 vUv; varying vec4 vCol;
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); vUv = uv; vCol = aCol; }`;
const FS = `
uniform sampler2D uTex; uniform float uAlphaCut;
varying vec2 vUv; varying vec4 vCol;
void main() {
  vec4 t = vUv.x < 0.0 ? vec4(1.0) : texture2D(uTex, vUv);
  if (vCol.a < 1.0) { float l = dot(t.rgb, vec3(0.3, 0.59, 0.11)); t.rgb = vec3(l); }
  vec4 c = vec4(t.rgb * vCol.rgb, t.a * vCol.a);
  if (c.a < uAlphaCut) discard;
  gl_FragColor = c;
}`;

const BOX_EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
const BOX_FACES = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]];

export class VoxelView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import("./voxels.js").VoxelGrid} grid
   */
  constructor(canvas, grid) {
    this.canvas = canvas;
    this.grid = grid;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    } catch {
      throw new Error("WebGL is not available in this browser");
    }
    this.renderer = renderer;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setClearColor(0x1c1f24, 1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(51.6, 1, 0.1, 2000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.addEventListener("change", () => (this.needsDraw = true));
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    white.needsUpdate = true;
    this.tex = white;
    const uniforms = (cut) => ({ uTex: { value: white }, uAlphaCut: { value: cut } });
    this.opaqueMat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: uniforms(0.5), side: THREE.DoubleSide });
    this.blendMat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: uniforms(0.02), side: THREE.DoubleSide, transparent: true, depthWrite: false });
    this.lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthTest: false });
    this.fillMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), this.lineMat);
    this.fills = new THREE.Mesh(new THREE.BufferGeometry(), this.fillMat);
    this.lines.renderOrder = 3; // lock outlines stay visible through blocks
    this.fills.renderOrder = 2;
    this.lines.frustumCulled = this.fills.frustumCulled = false;
    this.scene.add(this.lines, this.fills);

    /** chunk key → { opaque?: Mesh, blend?: Mesh } */
    this.meshes = new Map();
    this.models = {};
    this.states = new Map();
    this.fallbacks = new Map();
    this.atlasSize = [1, 1];
    /** Overlay boxes: { box, color: [r,g,b,a], fill?: alpha } (inclusive boxes). */
    this.overlays = [];
    this.flashes = [];
    /** Marks context voxels as ghosts (drill-in); undefined for none. */
    this.ghost = undefined;
    this.needsDraw = true;
    this.onFrame = null;
    this.fit({ min: [0, 0, 0], max: [15, 15, 15] });
    const loop = () => {
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    for (const k of [...this.meshes.keys()]) this.dropMesh(k);
    this.lines.geometry.dispose();
    this.fills.geometry.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /** Baked models by state id (from /assets/models.json) and the state names (for fallbacks). */
  setModels(models, states) {
    this.models = models || {};
    this.states = states;
    this.fallbacks.clear();
    this.remeshAll();
  }

  setAtlas(img) {
    const tex = new THREE.Texture(img);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.flipY = false; // baked UVs are pixels from the atlas's top-left
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    const old = this.tex;
    this.tex = tex;
    this.opaqueMat.uniforms.uTex.value = tex;
    this.blendMat.uniforms.uTex.value = tex;
    old.dispose();
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

  /** Points the camera at an inclusive box, keeping the current viewing direction. */
  fit(box) {
    if (!box) return;
    const c = new THREE.Vector3(...[0, 1, 2].map((i) => (box.min[i] + box.max[i] + 1) / 2));
    const size = Math.max(...[0, 1, 2].map((i) => box.max[i] - box.min[i] + 1));
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(Math.cos(0.6) * Math.sin(Math.PI * 0.75), Math.sin(0.6), Math.cos(0.6) * Math.cos(Math.PI * 0.75));
    dir.normalize().multiplyScalar(Math.max(8, size * 1.8));
    this.controls.target.copy(c);
    this.camera.position.copy(c).add(dir);
    this.controls.update();
    this.needsDraw = true;
  }

  /** Briefly highlights a changed box (12: recently changed blocks). */
  flash(box, color = [1, 0.85, 0.2]) {
    this.flashes.push({ box, color, until: performance.now() + 1500 });
    this.needsDraw = true;
  }

  /** Screen position (CSS px) of a world point, or null when behind the camera. */
  project(p) {
    const v = new THREE.Vector3(p[0], p[1], p[2]);
    if (v.clone().applyMatrix4(this.camera.matrixWorldInverse).z >= 0) return null;
    v.project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return [(v.x * 0.5 + 0.5) * r.width, (1 - (v.y * 0.5 + 0.5)) * r.height];
  }

  frame() {
    const now = performance.now();
    this.flashes = this.flashes.filter((f) => f.until > now);
    const dirty = this.grid.dirty.size > 0;
    if (!dirty && !this.needsDraw && !this.flashes.length && !this.resized()) return;
    this.needsDraw = false;
    // Remesh dirty chunks (bounded per frame so a big snapshot doesn't freeze the page).
    let budget = 64;
    for (const k of this.grid.dirty) {
      if (budget-- <= 0) break;
      this.grid.dirty.delete(k);
      this.upload(k, meshChunk(this.grid, k, this.modelFor, this.atlasSize, this.ghost));
    }
    if (this.grid.dirty.size) this.needsDraw = true;

    const dist = this.camera.position.distanceTo(this.controls.target);
    this.camera.near = Math.max(0.1, dist / 200);
    this.camera.far = dist * 20 + 1000;
    this.camera.updateProjectionMatrix();
    this.updateOverlays(now);
    this.renderer.render(this.scene, this.camera);
    this.onFrame?.();
  }

  resized() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (this.size?.[0] === w && this.size?.[1] === h && this.size?.[2] === dpr) return false;
    this.size = [w, h, dpr];
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    return true;
  }

  upload(key, mesh) {
    this.dropMesh(key);
    if (!mesh.opaque.length && !mesh.blend.length) return;
    const m = {};
    for (const part of ["opaque", "blend"]) {
      const data = mesh[part];
      if (!data.length) continue;
      const buf = new THREE.InterleavedBuffer(data, STRIDE);
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.InterleavedBufferAttribute(buf, 3, 0));
      g.setAttribute("uv", new THREE.InterleavedBufferAttribute(buf, 2, 3));
      g.setAttribute("aCol", new THREE.InterleavedBufferAttribute(buf, 4, 5));
      const obj = new THREE.Mesh(g, part === "opaque" ? this.opaqueMat : this.blendMat);
      if (part === "blend") obj.renderOrder = 1;
      m[part] = obj;
      this.scene.add(obj);
    }
    this.meshes.set(key, m);
  }

  dropMesh(key) {
    const m = this.meshes.get(key);
    if (!m) return;
    for (const obj of [m.opaque, m.blend]) {
      if (!obj) continue;
      this.scene.remove(obj);
      obj.geometry.dispose();
    }
    this.meshes.delete(key);
  }

  updateOverlays(now) {
    const lines = [], lineCol = [], tris = [], triCol = [];
    const all = [...this.overlays, ...this.flashes.map((f) => ({ box: f.box, color: [...f.color, Math.max(0, (f.until - now) / 1500)] }))];
    for (const o of all) {
      const [x0, y0, z0] = o.box.min.map((v) => v - 0.02), [x1, y1, z1] = o.box.max.map((v) => v + 1.02);
      const col = o.color.length === 4 ? o.color : [...o.color, 1];
      const c = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
      for (const [a, b] of BOX_EDGES) {
        lines.push(...c[a], ...c[b]);
        lineCol.push(...col, ...col);
      }
      if (o.fill) {
        const fc = [col[0], col[1], col[2], o.fill];
        for (const f of BOX_FACES)
          for (const i of [0, 1, 2, 0, 2, 3]) {
            tris.push(...c[f[i]]);
            triCol.push(...fc);
          }
      }
    }
    setGeometry(this.lines, lines, lineCol);
    setGeometry(this.fills, tris, triCol);
  }
}

function setGeometry(obj, pos, col) {
  obj.geometry.dispose();
  const g = new THREE.BufferGeometry();
  if (pos.length) {
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
  }
  obj.geometry = g;
  obj.visible = pos.length > 0;
}

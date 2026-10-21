import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { FloorPlanConfig, PlanZone, StateMessage, ZoneStatus } from "../../../shared/types";
import { PLAN_WIDTH, PLAN_HEIGHT, SIM_COLS, SIM_ROWS, planToSimCell } from "../../../shared/floorplan";
import { heatRgb } from "../../../shared/heat";
import { layoutEquipment, type EquipItem } from "../../../shared/equipment";

/**
 * 3D FACTORY VIEW (three.js). Plan coordinates map to the scene like this:
 *   scene x = plan x - 500,  scene z = plan y - 300,  scene y = height above the floor. 1 plan unit = 1 scene unit.
 * The floor is a texture of the live thermal grid. Walls, machines, conveyors and racks are drawn from the saved
 * floor plan (see shared/equipment.ts); they are visual only. Machines glow with the temperature of the floor under them.
 */
const WALL_H = 46;
const OUTER_H = 62;
const STATUS_HEX: Record<ZoneStatus, number> = { normal: 0x0f9d68, warning: 0xf2a900, critical: 0xd6264a };
const STATUS_CSS: Record<ZoneStatus, string> = { normal: "#0f9d68", warning: "#b57f00", critical: "#d6264a" };
const STATUS_TEXT: Record<ZoneStatus, string> = { normal: "OK", warning: "▲ WARNING", critical: "✖ CRITICAL" };

export interface Probe { x: number; y: number; text: string }
export interface ColourField { u: Float32Array }

const toScene = (px: number, py: number) => new THREE.Vector3(px - PLAN_WIDTH / 2, 0, py - PLAN_HEIGHT / 2);

function stripeTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 16;
  const g = c.getContext("2d")!;
  g.fillStyle = "#23292e"; g.fillRect(0, 0, 64, 16);
  g.fillStyle = "#59636b";
  for (let x = 0; x < 64; x += 16) g.fillRect(x, 0, 6, 16);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function labelTexture(lines: { text: string; colour: string; size: number }[]): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 176;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(255,255,255,.94)";
  g.beginPath(); g.roundRect(4, 4, 504, 168, 18); g.fill();
  g.strokeStyle = "rgba(29,32,37,.16)"; g.lineWidth = 3; g.stroke();
  let y = 18;
  for (const l of lines) {
    g.font = `700 ${l.size}px 'Segoe UI', sans-serif`;
    g.fillStyle = l.colour;
    g.textBaseline = "top";
    g.fillText(l.text, 22, y, 470);
    y += l.size + 10;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface MachineRef { mesh: THREE.Mesh; mat: THREE.MeshLambertMaterial; cell: number }
interface ZoneRef { zone: PlanZone; sprite: THREE.Sprite; beacon: THREE.Mesh; text: string; fireAt: THREE.Vector3 }

export class FactoryScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private floor: THREE.Mesh;
  private floorTex: THREE.CanvasTexture;
  private small = document.createElement("canvas");
  private big = document.createElement("canvas");
  private stripes = stripeTexture();
  private root = new THREE.Group(); // everything that depends on the floor plan
  private fireGroup = new THREE.Group();
  private machines: MachineRef[] = [];
  private zones = new Map<string, ZoneRef>();
  private fires = new Map<string, THREE.Group>();
  private raycaster = new THREE.Raycaster();
  private values: number[] = [];
  private owners: Int16Array | null = null;
  private plan: FloorPlanConfig | null = null;
  private raf = 0;
  private disposed = false;
  private width = 0;
  private height = 0;

  constructor(private el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0xeceff2);
    el.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";

    this.camera = new THREE.PerspectiveCamera(38, 16 / 9, 5, 5000);
    this.resetView();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 250;
    this.controls.maxDistance = 2200;
    this.controls.target.set(0, 0, 20);
    this.controls.update();

    this.scene.background = new THREE.Color(0xeceff2);
    this.scene.fog = new THREE.Fog(0xeceff2, 1800, 3600);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(-420, 900, 520);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x9fc4ff, 0.45);
    fill.position.set(500, 300, -400);
    this.scene.add(fill);

    // base slab under the whole plan, so the factory looks like a solid block
    const slab = new THREE.Mesh(new THREE.BoxGeometry(PLAN_WIDTH + 24, 14, PLAN_HEIGHT + 24), new THREE.MeshLambertMaterial({ color: 0xd9dee4 }));
    slab.position.y = -7.5;
    this.scene.add(slab);

    this.small.width = SIM_COLS; this.small.height = SIM_ROWS;
    this.big.width = SIM_COLS * 10; this.big.height = SIM_ROWS * 10;
    const g = this.big.getContext("2d")!;
    g.fillStyle = "#2a7"; g.fillRect(0, 0, this.big.width, this.big.height);
    this.floorTex = new THREE.CanvasTexture(this.big);
    this.floorTex.colorSpace = THREE.SRGBColorSpace;
    this.floorTex.anisotropy = 8;
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(PLAN_WIDTH, PLAN_HEIGHT), new THREE.MeshBasicMaterial({ map: this.floorTex }));
    this.floor.rotation.x = -Math.PI / 2;
    this.scene.add(this.floor);
    this.scene.add(this.root, this.fireGroup);

    this.resize();
    const loop = (t: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      this.stripes.offset.x = (t / 1000) * 0.35; // conveyors run
      this.fires.forEach((f, i) => f.children.forEach((c, k) => {
        if (c instanceof THREE.Mesh) { const s = 0.85 + 0.25 * Math.sin(t / 110 + k * 2 + hashStr(i)); c.scale.set(s, 0.8 + 0.4 * Math.sin(t / 90 + k), s); }
      }));
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  resetView() {
    this.camera.position.set(330, 560, 760);
    this.camera.lookAt(0, 0, 20);
    if (this.controls) { this.controls.target.set(0, 0, 20); this.controls.update(); }
  }

  resize() {
    const w = this.el.clientWidth || 900, h = this.el.clientHeight || 520;
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** (Re)build walls, outlines, equipment, labels and beacons from the saved floor plan. */
  setPlan(plan: FloorPlanConfig | null, owners: Int16Array) {
    this.plan = plan;
    this.owners = owners;
    this.clearRoot();
    if (!plan) return;

    const wallMat = new THREE.MeshLambertMaterial({ color: 0x9fb0bb, transparent: true, opacity: 0.22, depthWrite: false });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x6b7783, transparent: true, opacity: 0.75 });
    const box = (w: number, h: number, d: number, mat: THREE.Material, at: THREE.Vector3, edges = true) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      const m = new THREE.Mesh(geo, mat);
      m.position.copy(at);
      this.root.add(m);
      if (edges) { const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat); e.position.copy(at); this.root.add(e); }
      return m;
    };

    // outer walls
    const outer = new THREE.MeshLambertMaterial({ color: 0xaab7c0, transparent: true, opacity: 0.14, depthWrite: false });
    const T = 6;
    box(PLAN_WIDTH + T, OUTER_H, T, outer, new THREE.Vector3(0, OUTER_H / 2, -PLAN_HEIGHT / 2));
    box(PLAN_WIDTH + T, OUTER_H, T, outer, new THREE.Vector3(0, OUTER_H / 2, PLAN_HEIGHT / 2));
    box(T, OUTER_H, PLAN_HEIGHT, outer, new THREE.Vector3(-PLAN_WIDTH / 2, OUTER_H / 2, 0));
    box(T, OUTER_H, PLAN_HEIGHT, outer, new THREE.Vector3(PLAN_WIDTH / 2, OUTER_H / 2, 0));

    for (const z of plan.zones) {
      // zone walls (4 slabs), with a 44-unit doorway gap in the middle of the bottom wall so zones read as rooms
      const c = toScene(z.x + z.w / 2, z.y + z.h / 2);
      const t = 4;
      const door = Math.min(44, z.w * 0.4);
      const sideW = (z.w - door) / 2;
      box(z.w, WALL_H, t, wallMat, new THREE.Vector3(c.x, WALL_H / 2, c.z - z.h / 2));
      box(t, WALL_H, z.h, wallMat, new THREE.Vector3(c.x - z.w / 2, WALL_H / 2, c.z));
      box(t, WALL_H, z.h, wallMat, new THREE.Vector3(c.x + z.w / 2, WALL_H / 2, c.z));
      box(sideW, WALL_H, t, wallMat, new THREE.Vector3(c.x - z.w / 2 + sideW / 2, WALL_H / 2, c.z + z.h / 2));
      box(sideW, WALL_H, t, wallMat, new THREE.Vector3(c.x + z.w / 2 - sideW / 2, WALL_H / 2, c.z + z.h / 2));

      // equipment
      layoutEquipment(z).forEach((it) => this.addEquipment(it));

      // label + status beacon
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture([{ text: z.name, colour: "#1d2025", size: 44 }]), depthTest: false, transparent: true }));
      sprite.scale.set(122, 42, 1);
      sprite.position.set(c.x, WALL_H + 30, c.z);
      sprite.renderOrder = 10;
      this.root.add(sprite);
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(7, 16, 12), new THREE.MeshBasicMaterial({ color: STATUS_HEX.normal }));
      beacon.position.set(c.x - z.w / 2 + 10, WALL_H + 8, c.z - z.h / 2 + 10);
      this.root.add(beacon);
      this.zones.set(z.id, { zone: z, sprite, beacon, text: "", fireAt: new THREE.Vector3(c.x, 0, c.z) });
    }

    for (const ex of plan.exits) {
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(9), new THREE.MeshBasicMaterial({ color: 0x1d6fb8 }));
      const p = toScene(ex.x, ex.y);
      m.position.set(p.x, 14, p.z);
      this.root.add(m);
    }
  }

  private addEquipment(it: EquipItem) {
    const p = toScene(it.x, it.y);
    let geo: THREE.BufferGeometry;
    let mat: THREE.MeshLambertMaterial;
    const palette: Record<string, number> = { machine: 0xeef1f3, oven: 0xd9dde0, rack: 0x7d8a93, tank: 0xc9d1d6, desk: 0x9aa7b0, pallet: 0xb8956a };
    if (it.kind === "conveyor") {
      geo = new THREE.BoxGeometry(it.w, it.h, it.d);
      const m = new THREE.Mesh(geo, [
        new THREE.MeshLambertMaterial({ color: 0x3b454c }), new THREE.MeshLambertMaterial({ color: 0x3b454c }),
        new THREE.MeshLambertMaterial({ map: this.stripes }), new THREE.MeshLambertMaterial({ color: 0x3b454c }),
        new THREE.MeshLambertMaterial({ color: 0x3b454c }), new THREE.MeshLambertMaterial({ color: 0x3b454c }),
      ]);
      m.position.set(p.x, it.h / 2 + 6, p.z);
      this.root.add(m);
      // legs
      for (let lx = -it.w / 2 + 8; lx < it.w / 2; lx += 60) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(3, 6, it.d - 2), new THREE.MeshLambertMaterial({ color: 0x59636b }));
        leg.position.set(p.x + lx, 3, p.z);
        this.root.add(leg);
      }
      return;
    }
    if (it.kind === "tank") geo = new THREE.CylinderGeometry(it.w / 2, it.w / 2, it.h, 24);
    else geo = new THREE.BoxGeometry(it.w, it.h, it.d);
    mat = new THREE.MeshLambertMaterial({ color: palette[it.kind] ?? 0xdddddd });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(p.x, it.h / 2, p.z);
    this.root.add(mesh);
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x1b252b, transparent: true, opacity: 0.5 }));
    outline.position.copy(mesh.position);
    this.root.add(outline);

    if (it.kind === "machine" || it.kind === "oven") {
      // control panel / hopper on top so machines read as machines
      const top = new THREE.Mesh(new THREE.BoxGeometry(it.w * 0.45, it.h * 0.3, it.d * 0.45), new THREE.MeshLambertMaterial({ color: it.kind === "oven" ? 0x8a949b : 0x3f8fd6 }));
      top.position.set(p.x, it.h + (it.h * 0.3) / 2, p.z);
      this.root.add(top);
      const cell = planToSimCell(it.x, it.y);
      this.machines.push({ mesh, mat, cell: cell.row * SIM_COLS + cell.col });
    }
    if (it.kind === "rack") {
      // shelves
      for (const f of [0.33, 0.66]) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(it.w + 1, 1.5, it.d + 1), new THREE.MeshLambertMaterial({ color: 0xe0a43a }));
        s.position.set(p.x, it.h * f, p.z);
        this.root.add(s);
      }
    }
  }

  private clearRoot() {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => disposeMat(x, this.stripes));
      else if (mat) disposeMat(mat, this.stripes);
    });
    this.root.clear();
    this.machines = [];
    this.zones.clear();
    this.fires.forEach((f) => this.fireGroup.remove(f));
    this.fires.clear();
  }

  /** Push the latest live state into the scene: heat floor, glowing machines, labels, beacons, fires. */
  update(state: StateMessage | null, colours: ColourField | null) {
    if (state?.grid) this.values = state.grid.values;
    if (colours) {
      const g = this.small.getContext("2d")!;
      const img = g.createImageData(SIM_COLS, SIM_ROWS);
      for (let i = 0; i < SIM_COLS * SIM_ROWS; i++) {
        const [r, gg, b] = heatRgb(colours.u[i]);
        img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      const bg = this.big.getContext("2d")!;
      bg.imageSmoothingEnabled = true;
      bg.imageSmoothingQuality = "high";
      bg.drawImage(this.small, 0, 0, this.big.width, this.big.height);
      this.floorTex.needsUpdate = true;
      for (const m of this.machines) {
        const [r, gg, b] = heatRgb(colours.u[m.cell] ?? 0.5);
        const hot = Math.max(0, (colours.u[m.cell] ?? 0.5) - 0.5) * 1.6; // glow only when warmer than mid-range
        m.mat.emissive.setRGB((r / 255) * hot, (gg / 255) * hot * 0.6, (b / 255) * hot * 0.3);
      }
    }
    const live = new Map((state?.zones ?? []).map((z) => [z.id, z]));
    const failed = new Set(state?.sim?.failedCoolers ?? []);
    for (const [id, zr] of this.zones) {
      const lz = live.get(id);
      const status = lz?.status ?? "normal";
      (zr.beacon.material as THREE.MeshBasicMaterial).color.setHex(STATUS_HEX[status]);
      const lines = [{ text: zr.zone.name, colour: "#1d2025", size: 42 }];
      if (lz) lines.push({ text: `${lz.temperatureC.toFixed(1)} °C   max ${lz.maxCellC.toFixed(1)}`, colour: "#5b6470", size: 34 });
      if (lz && status !== "normal") lines.push({ text: STATUS_TEXT[status], colour: STATUS_CSS[status], size: 34 });
      else if (lz?.ai?.alert) lines.push({ text: "⚠ AI EARLY WARNING", colour: "#b57f00", size: 34 });
      else if (failed.has(id)) lines.push({ text: "❄ COOLER FAILED", colour: "#1d6fb8", size: 34 });
      const key = lines.map((l) => l.text).join("|") + (failed.has(id) ? "f" : "");
      if (key !== zr.text) {
        zr.text = key;
        const mat = zr.sprite.material as THREE.SpriteMaterial;
        mat.map?.dispose();
        mat.map = labelTexture(lines);
        mat.needsUpdate = true;
      }
    }
    // fires
    const want = new Set((state?.sim?.fires ?? []).filter((f) => f.zoneId && this.zones.has(f.zoneId)).map((f) => f.zoneId as string));
    for (const [id, grp] of this.fires) if (!want.has(id)) { this.fireGroup.remove(grp); this.fires.delete(id); }
    for (const id of want) {
      if (this.fires.has(id)) continue;
      const zr = this.zones.get(id)!;
      const grp = new THREE.Group();
      const cols = [0xff3d00, 0xff9100, 0xffd54f];
      cols.forEach((c, k) => {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(16 - k * 4, 46 - k * 10, 10), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9 }));
        cone.position.set((k - 1) * 8, 23 - k * 4, (k % 2) * 6);
        grp.add(cone);
      });
      const light = new THREE.PointLight(0xff7a2a, 3, 260);
      light.position.set(0, 40, 0);
      grp.add(light);
      grp.position.copy(zr.fireAt);
      this.fireGroup.add(grp);
      this.fires.set(id, grp);
    }
  }

  /** Temperature under the mouse (floor only), or null. */
  probe(clientX: number, clientY: number): Probe | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -(((clientY - r.top) / r.height) * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.floor, false)[0];
    if (!hit || this.values.length !== SIM_COLS * SIM_ROWS) return null;
    const px = hit.point.x + PLAN_WIDTH / 2, py = hit.point.z + PLAN_HEIGHT / 2;
    const { col, row } = planToSimCell(px, py);
    const i = row * SIM_COLS + col;
    const zi = this.owners ? this.owners[i] : -1;
    const zone = zi >= 0 ? this.plan?.zones[zi] : undefined;
    return { x: clientX - r.left, y: clientY - r.top, text: `${this.values[i].toFixed(1)} °C · ${zone?.name ?? "open floor"}` };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.clearRoot();
    this.controls.dispose();
    this.floorTex.dispose();
    this.stripes.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function disposeMat(m: THREE.Material, keep: THREE.Texture) {
  const mm = m as THREE.MeshLambertMaterial;
  if (mm.map && mm.map !== keep) mm.map.dispose();
  m.dispose();
}
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h % 100;
}

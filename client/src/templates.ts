import type { FloorPlanConfig, LinkKind } from "../../shared/types";
import { SIM_COLS } from "../../shared/floorplan";

type Layout = Pick<FloorPlanConfig, "zones" | "exits" | "links">;
type T = "general" | "hot-process" | "cold-storage";
// limits: type, minC, maxC, warnMarginC
const z = (id: string, name: string, x: number, y: number, w: number, h: number, type: T, minC: number, maxC: number, warnMarginC: number) =>
  ({ id, name, x, y, w, h, type, minC, maxC, warnMarginC });
const e = (id: string, x: number, y: number) => ({ id, x, y });
const l = (id: string, a: string, b: string, kind: LinkKind) => ({ id, a, b, kind });

// A painted (free-form) region from rectangles of simulation cells: [col0, row0, col1, row1] inclusive. Zones have no walls.
const paint = (id: string, name: string, rects: [number, number, number, number][], type: T, minC: number, maxC: number, warnMarginC: number) => {
  const cells = new Set<number>();
  for (const [c0, r0, c1, r1] of rects) for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.add(r * SIM_COLS + c);
  return { id, name, x: 0, y: 0, w: 0, h: 0, cells: [...cells].sort((a, b) => a - b), type, minC, maxC, warnMarginC }; // the server derives x, y, w, h
};

// Coordinates are plan units (1000 x 600), aligned to the 10-unit grid.
export const TEMPLATES: { key: string; label: string; build: () => Layout }[] = [
  {
    key: "factory",
    label: "Factory template",
    build: () => ({
      zones: [
        z("tpl-receiving", "Receiving", 40, 40, 220, 160, "general", 10, 30, 2),
        z("tpl-assembly", "Assembly Line", 280, 40, 420, 260, "general", 15, 45, 4),
        z("tpl-paint", "Paint Booth", 720, 40, 240, 160, "hot-process", 20, 90, 6),
        z("tpl-storage", "Storage", 40, 220, 220, 340, "general", 5, 35, 3),
        z("tpl-office", "Office", 720, 220, 240, 140, "general", 18, 26, 1),
        z("tpl-packaging", "Packaging", 280, 320, 300, 240, "general", 12, 38, 3),
        z("tpl-shipping", "Shipping", 600, 380, 360, 180, "general", 5, 35, 3),
      ],
      exits: [e("tpl-exit-1", 20, 120), e("tpl-exit-2", 980, 300), e("tpl-exit-3", 500, 580)],
      // heat can travel along these: a paint-feed pipeline, an exhaust duct, and the conveyors of the line
      links: [
        l("tpl-link-1", "tpl-paint", "tpl-assembly", "pipe"),
        l("tpl-link-2", "tpl-paint", "tpl-office", "duct"),
        l("tpl-link-3", "tpl-assembly", "tpl-packaging", "conveyor"),
        l("tpl-link-4", "tpl-packaging", "tpl-shipping", "conveyor"),
        l("tpl-link-5", "tpl-receiving", "tpl-storage", "door"),
      ],
    }),
  },
  {
    key: "hall",
    label: "Open hall template",
    build: () => ({
      // one big hall, no walls: areas are painted cell by cell and can be any shape
      zones: [
        paint("tpl-hall-bay", "Loading bay", [[1, 1, 9, 8]], "general", 10, 35, 3),
        paint("tpl-hall-charge", "Charging area", [[12, 2, 22, 5], [12, 6, 14, 10]], "general", 10, 40, 4),
        paint("tpl-hall-hot", "Machine hot spot", [[29, 5, 33, 5], [28, 6, 34, 9], [29, 10, 33, 10]], "hot-process", 15, 80, 6),
        paint("tpl-hall-cold", "Cold pallet area", [[2, 14, 12, 22]], "cold-storage", 2, 14, 2),
        paint("tpl-hall-lanes", "Packing lanes", [[16, 15, 37, 18]], "general", 10, 38, 3),
        paint("tpl-hall-battery", "Battery rack (watch)", [[26, 21, 27, 22]], "general", 10, 38, 4),
      ],
      exits: [e("tpl-exit-1", 20, 300), e("tpl-exit-2", 980, 300), e("tpl-exit-3", 500, 580)],
      links: [l("tpl-hall-link-1", "tpl-hall-hot", "tpl-hall-lanes", "duct")],
    }),
  },
  {
    key: "cold",
    label: "Cold-storage template",
    build: () => ({
      zones: [
        z("tpl-cold-a", "Cold Room A", 200, 40, 360, 250, "cold-storage", 2, 8, 1),
        z("tpl-cold-b", "Cold Room B", 580, 40, 380, 250, "cold-storage", 2, 8, 1),
        z("tpl-anteroom", "Anteroom", 40, 240, 140, 120, "general", 8, 18, 2),
        z("tpl-blast", "Blast Freezer", 200, 310, 240, 250, "cold-storage", -25, -15, 2),
        z("tpl-staging", "Dispatch Staging", 460, 310, 500, 250, "cold-storage", 0, 10, 1.5),
        z("tpl-dock", "Loading Dock", 40, 380, 140, 180, "general", 5, 20, 2),
      ],
      exits: [e("tpl-exit-1", 20, 300), e("tpl-exit-2", 450, 580), e("tpl-exit-3", 980, 430)],
      links: [
        l("tpl-cold-link-1", "tpl-cold-a", "tpl-cold-b", "pipe"),
        l("tpl-cold-link-2", "tpl-anteroom", "tpl-cold-a", "door"),
        l("tpl-cold-link-3", "tpl-blast", "tpl-staging", "conveyor"),
      ],
    }),
  },
];

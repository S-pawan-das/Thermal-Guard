import type { FloorPlanConfig } from "../../shared/types";

type Layout = Pick<FloorPlanConfig, "zones" | "exits">;
type T = "general" | "hot-process" | "cold-storage";
// limits: type, minC, maxC, warnMarginC
const z = (id: string, name: string, x: number, y: number, w: number, h: number, type: T, minC: number, maxC: number, warnMarginC: number) =>
  ({ id, name, x, y, w, h, type, minC, maxC, warnMarginC });
const e = (id: string, x: number, y: number) => ({ id, x, y });

// Coordinates are plan units (1000 x 600), aligned to the 10-unit grid.
export const TEMPLATES: { key: string; label: string; build: () => Layout }[] = [
  {
    key: "factory",
    label: "Factory template",
    build: () => ({
      zones: [
        z("tpl-receiving", "Receiving", 40, 40, 220, 160, "general", 10, 30, 2),
        z("tpl-assembly", "Assembly Line", 280, 40, 420, 260, "general", 15, 32, 2),
        z("tpl-paint", "Paint Booth", 720, 40, 240, 160, "hot-process", 20, 60, 5),
        z("tpl-storage", "Storage", 40, 220, 220, 340, "general", 5, 35, 3),
        z("tpl-office", "Office", 720, 220, 240, 140, "general", 18, 26, 1),
        z("tpl-packaging", "Packaging", 280, 320, 300, 240, "general", 12, 30, 2),
        z("tpl-shipping", "Shipping", 600, 380, 360, 180, "general", 5, 35, 3),
      ],
      exits: [e("tpl-exit-1", 20, 120), e("tpl-exit-2", 980, 300), e("tpl-exit-3", 500, 580)],
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
    }),
  },
];

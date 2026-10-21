// "Running factory" demo: continuous machine heat on top of the Factory template.
// Machines use the simulator's existing heat sources (steady, never above targetC), placed by plan coordinates.
// Posted to PUT /api/sim/scenario (see README, Milestone 6).
const machine = (id: string, x: number, y: number, targetC: number, strength: number) => ({ id, x, y, targetC, strength, startStep: 0, endStep: null });

export const FACTORY_DEMO_SCENARIO = {
  name: "factory-running",
  seed: 7,
  initialNoiseC: 0.4,
  sources: [
    // assembly line: a row of machines along the conveyor
    machine("asm-1", 340, 130, 48, 0.2),
    machine("asm-2", 420, 190, 48, 0.2),
    machine("asm-3", 500, 130, 48, 0.2),
    machine("asm-4", 580, 190, 48, 0.2),
    machine("asm-5", 650, 130, 48, 0.2),
    // paint booth ovens
    machine("paint-1", 800, 100, 78, 0.25),
    machine("paint-2", 900, 140, 78, 0.25),
    // packaging heat-sealers and shipping dock equipment
    machine("seal-1", 430, 430, 45, 0.15),
    machine("seal-2", 500, 470, 45, 0.15),
    machine("dock-1", 700, 480, 36, 0.12),
  ],
};

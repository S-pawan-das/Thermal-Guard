// "Running factory" demo: machines that heat the floor, on top of the Factory template.
// Machines are the simulator's heat sources (steady, never above targetC) placed by plan coordinates. They all start cold at
// step 0, like a working day, so the machine-cycle monitor can learn "how much each machine warms its surroundings in 30 minutes".
// Posted to PUT /api/sim/scenario (see README).
const machine = (id: string, name: string, x: number, y: number, targetC: number, strength: number) =>
  ({ id, name, x, y, targetC, strength, startStep: 0, endStep: null });

export const FACTORY_DEMO_SCENARIO = {
  name: "factory-running",
  seed: 7,
  initialNoiseC: 0.4,
  sources: [
    // assembly line: a row of machines along the conveyor
    machine("asm-1", "Assembly robot 1", 340, 130, 44, 0.2),
    machine("asm-2", "Assembly robot 2", 420, 190, 44, 0.2),
    machine("asm-3", "Assembly robot 3", 500, 130, 44, 0.2),
    machine("asm-4", "Assembly robot 4", 580, 190, 44, 0.2),
    machine("asm-5", "Assembly robot 5", 650, 130, 44, 0.2),
    // paint booth ovens
    machine("paint-1", "Paint oven 1", 800, 100, 78, 0.25),
    machine("paint-2", "Paint oven 2", 900, 140, 78, 0.25),
    // packaging heat-sealers and shipping dock equipment
    machine("seal-1", "Heat sealer 1", 430, 430, 40, 0.15),
    machine("seal-2", "Heat sealer 2", 500, 470, 40, 0.15),
    machine("dock-1", "Dock heater", 700, 480, 36, 0.12),
  ],
};

// "Open hall" demo: machines in a wall-less warehouse. The battery-rack charger is the one to watch: run a day with it
// "overheating" (Simulator tab) and the monitor flags it long before the rack gets near its limit.
export const HALL_DEMO_SCENARIO = {
  name: "open-hall-running",
  seed: 5,
  initialNoiseC: 0.4,
  sources: [
    machine("hall-oven", "Curing oven", 790, 180, 70, 0.2),
    machine("hall-chg-1", "Forklift charger 1", 412, 84, 36, 0.12),
    machine("hall-chg-2", "Forklift charger 2", 337, 204, 36, 0.12),
    machine("hall-battery", "Battery pack charger", 675, 528, 32, 0.1),
    machine("hall-pack", "Packing line motor", 600, 400, 30, 0.1),
    machine("hall-bay", "Dock heater", 100, 100, 30, 0.08),
  ],
};

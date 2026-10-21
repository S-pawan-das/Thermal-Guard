# ml/ — the early-warning model (trained from scratch, no outside model)

**What it does.** For every zone, every simulation step, it answers: *"will this zone go out of its limits within the next 30 steps?"* and outputs a risk from 0 to 1.
The alarm turns on when the risk stays above a threshold that was tuned on validation data.
It only sees what a real sensor system would: each zone's recent coldest / hottest / average reading (last 48 steps) and the zone's own limits.

**The model.** A small neural network (28 inputs → 48 → 24 → 1), written in plain TypeScript. Weights live in `shared/forecastModel.ts` (generated), the feature and inference code in `shared/forecast.ts`.
The server and the scripts here use the *same* code, so training, testing and the live app behave identically.

## Commands (from the project root)
| Command | What it does | Time |
|---|---|---|
| `npm run ml:train` | generates ~900 simulated episodes, trains, picks the alarm threshold on validation data, rewrites `shared/forecastModel.ts` | ~4 min |
| `npm run ml:eval` | tests on episodes the model never saw (different seeds, plus brand-new random floor plans) and writes `ml/RESULTS.md` | ~4 min |
| `npm run ml:typecheck` | type-checks the scripts | seconds |

Everything is seeded, so the same command gives the same model and the same numbers.

## Where the data comes from
`episodes.ts` runs the real thermal simulator many times with random floor plans (the two templates with jittered limits, plus random layouts), random physics settings, steady machines, slow ambient drift,
sensor noise (up to 0.2 °C) and one incident per episode: **cooling failure**, **fire**, **gradual machine overheating**, **door left open**, or a **quiet** run with only brief harmless disturbances.
`metrics.ts` holds the scoring rules (what counts as "warned early", "missed" and "false alarm"), shared by validation and the final test.

## Honest results (see `RESULTS.md` for the full tables)
Held-out test: 4,538 zone-runs, 582 real breaches. Alarm threshold chosen on validation data. One step = one second at demo speed.

| Detector | Warned before the zone went out of range | Median warning time | False alarms / 100 zone-runs |
|---|---|---|---|
| Plain threshold alarm | 4% | 1 step | 3.1 |
| The app's warning margin, tuned to the **same** false-alarm rate | 29% | 2 steps | 4.1 |
| **AI model** | 25% (59% of cooling failures, 67% of overheating) | **15 steps** | 4.1 |

- The AI warns **about 7× earlier** than the margin alarm at the same false-alarm level, and about as often. It is not a higher catch rate.
- The un-tuned margin alarm catches more breaches (about 50%) but raises 24–56 false alarms per 100 zone-runs on the cold-storage and random layouts.
- **Fires and a door left open** go from normal to out-of-range in a few steps with no earlier sign in the readings. Nobody can warn ahead of those from temperatures alone, and neither can this model (2–4%).
- Results are on simulated data from this project's own simulator, not on real sensors. Treat them as a demonstration of the method.

## Things to try next
More incident types and longer episodes; per-zone time-to-breach estimates; letting the model see the cooler/fan state; retraining on real logs when available.

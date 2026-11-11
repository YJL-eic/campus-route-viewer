// Engineering-style UAV battery series for the chart and HUD.
// Energy still follows the course ledger: 0.8 × published range, with
// climb/descent each costing 10 × height meters of cruise-equivalent.
// The time history uses higher climb power and a mild Peukert bend so the
// curve looks like a typical LiPo flight log, not a straight line.

const RANGE_KM = { "20kg": 70, "10kg": 110 };
const USABLE = 0.8;
const CLIMB_SHARE = 0.2;
const DESCENT_SHARE = 0.2;

export function buildBatterySeries(route, aircraft) {
  if (!route?.feasible) return [];
  const published = RANGE_KM[aircraft] || 70;
  const usable = USABLE * published * 1000;
  const climbEq = 10 * route.height_m;
  const cruiseEq = route.distance_m;
  const descentEq = 10 * route.height_m;
  const total = climbEq + cruiseEq + descentEq;
  // Relative electrical power by phase (cruise = 1). Climb draws harder.
  const power = { climb: 2.15, cruise: 1, descent: 0.88 };
  const weight =
    power.climb * climbEq + power.cruise * cruiseEq + power.descent * descentEq;
  const samples = [];
  const steps = 48;
  for (let index = 0; index <= steps; index += 1) {
    const p = index / steps;
    const phase = phaseAt(p);
    const used = energyUsed(p, climbEq, cruiseEq, descentEq, power, weight, total);
    const energySoc = Math.max(0, (usable - used) / usable);
    samples.push({
      p: Number(p.toFixed(4)),
      phase,
      soc: Number(lipoRemaining(energySoc).toFixed(4)),
    });
  }
  return samples;
}

export function readSoc(samples, ratio) {
  if (!samples?.length) return 1;
  let previous = samples[0];
  for (const sample of samples) {
    if (sample.p >= ratio) {
      const span = sample.p - previous.p || 1;
      const mix = (ratio - previous.p) / span;
      return previous.soc + (sample.soc - previous.soc) * mix;
    }
    previous = sample;
  }
  return previous.soc;
}

const CRUISE_MPS = 30;
const TAKEOFF_MPS = 1.5;
const LANDING_MPS = 2;

export function flightTelemetry(route, phase, progress, altitude) {
  if (!route?.feasible) return { speed: 0, remain_m: 0 };
  const height = route.height_m || 1;
  const climbShare = CLIMB_SHARE;
  const descentShare = DESCENT_SHARE;
  const p = Math.max(0, Math.min(1, progress || 0));
  if (phase === "climb") {
    const frac = Math.min(1, p / climbShare);
    const ramp = Math.min(1400, Math.max(400, route.distance_m * 0.16));
    return {
      speed: roundSpeed(TAKEOFF_MPS + (CRUISE_MPS - TAKEOFF_MPS) * easeInOut(frac)),
      remain_m: Math.max(0, route.distance_m - ramp * frac + (height - (altitude || 0))),
    };
  }
  if (phase === "descent") {
    const frac = Math.min(1, Math.max(0, (p - (1 - descentShare)) / descentShare));
    const ramp = Math.min(1400, Math.max(400, route.distance_m * 0.16));
    return {
      speed: roundSpeed(CRUISE_MPS + (LANDING_MPS - CRUISE_MPS) * easeInOut(frac)),
      remain_m: Math.max(0, ramp * (1 - frac) + (altitude || 0)),
    };
  }
  if (phase === "cruise") {
    const cruiseFrac = Math.min(1, Math.max(0, (p - climbShare) / (1 - climbShare - descentShare)));
    // First moments after climb keep easing into cruise speed.
    const settle = Math.min(1, cruiseFrac / 0.08);
    const fromClimb = TAKEOFF_MPS + (CRUISE_MPS - TAKEOFF_MPS) * easeInOut(1);
    const speed = fromClimb + (CRUISE_MPS - fromClimb) * easeInOut(settle);
    return {
      speed: roundSpeed(speed),
      remain_m: Math.max(0, route.distance_m * (1 - cruiseFrac)),
    };
  }
  if (phase === "recharge") return { speed: 0, remain_m: 0 };
  return { speed: 0, remain_m: route.distance_m };
}

function easeInOut(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function roundSpeed(value) {
  return Math.round(value * 10) / 10;
}

function phaseAt(p) {
  if (p < CLIMB_SHARE) return "climb";
  if (p > 1 - DESCENT_SHARE) return "descent";
  return "cruise";
}

function energyUsed(p, climbEq, cruiseEq, descentEq, power, weight, total) {
  // Spend the same total cruise-equivalent energy, but front-load climb.
  let powered = 0;
  if (p <= CLIMB_SHARE) {
    powered = power.climb * climbEq * (p / CLIMB_SHARE);
  } else if (p <= 1 - DESCENT_SHARE) {
    const cruiseFrac = (p - CLIMB_SHARE) / (1 - CLIMB_SHARE - DESCENT_SHARE);
    powered = power.climb * climbEq + power.cruise * cruiseEq * cruiseFrac;
  } else {
    const descentFrac = (p - (1 - DESCENT_SHARE)) / DESCENT_SHARE;
    powered =
      power.climb * climbEq +
      power.cruise * cruiseEq +
      power.descent * descentEq * descentFrac;
  }
  return (powered / weight) * total;
}

function lipoRemaining(energySoc) {
  // Typical LiPo remaining indicator: flatter mid-pack, steeper near empty.
  const e = Math.max(0, Math.min(1, energySoc));
  if (e >= 0.25) {
    const t = (e - 0.25) / 0.75;
    return 0.22 + 0.78 * (0.35 * t + 0.65 * Math.pow(t, 0.72));
  }
  const t = e / 0.25;
  return 0.22 * Math.pow(t, 1.35);
}

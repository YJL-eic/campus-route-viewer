const CLIMB_SHARE = 0.2;
const DESCENT_SHARE = 0.2;
const TAKEOFF_MPS = 1.5;
const CRUISE_MPS = 30;
const LANDING_MPS = 2;
const CRUISE_SHARE = 1 - CLIMB_SHARE - DESCENT_SHARE;

function easeIntegral(fraction) {
  const x = clamp(fraction, 0, 1);
  return x ** 3 - 0.5 * x ** 4;
}

function climbIntegral(fraction) {
  const x = clamp(fraction, 0, 1);
  return TAKEOFF_MPS * x + (CRUISE_MPS - TAKEOFF_MPS) * easeIntegral(x);
}

function descentIntegral(fraction) {
  const x = clamp(fraction, 0, 1);
  return CRUISE_MPS * x + (LANDING_MPS - CRUISE_MPS) * easeIntegral(x);
}

const CLIMB_I = CLIMB_SHARE * climbIntegral(1);
const CRUISE_I = CRUISE_SHARE * CRUISE_MPS;
const DESCENT_I = DESCENT_SHARE * descentIntegral(1);
const SPEED_I = CLIMB_I + CRUISE_I + DESCENT_I;

export function prepareTrack(profile) {
  if (!profile?.all?.length) return null;
  const points = profile.all;
  const cum = [0];
  for (let index = 1; index < points.length; index += 1) {
    cum.push(cum[index - 1] + meters(points[index - 1], points[index]));
  }
  const total = cum[cum.length - 1] || 1;
  const climbCount = profile.climb.length;
  const cruiseCount = profile.cruise.length;
  const climbEnd = cum[Math.max(0, climbCount - 1)] || 0;
  const cruiseEnd = cum[Math.max(0, climbCount + cruiseCount - 1)] || climbEnd;
  return {
    points,
    cum,
    total,
    climbFrac: climbEnd / total,
    cruiseFrac: (cruiseEnd - climbEnd) / total,
    descentFrac: Math.max(0, 1 - cruiseEnd / total),
  };
}

export function poseOnTrack(track, ratio) {
  const p = clamp(ratio, 0, 1);
  const pathT = timeToPath(p, track);
  const point = sampleTrack(track, pathT);
  const ahead = sampleTrack(track, Math.min(1, pathT + 0.0015));
  let heading = courseHeading(point, ahead);
  if (!Number.isFinite(heading)) heading = 0;
  const phase = p < CLIMB_SHARE ? "climb" : p > 1 - DESCENT_SHARE ? "descent" : "cruise";
  return { point, ahead, heading, phase, pathT };
}

export function lerpAngle(from, to, amount) {
  const delta = ((to - from + 540) % 360) - 180;
  return (from + delta * amount + 360) % 360;
}

export function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

export function easeInOut(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function timeToPath(ratio) {
  // 位移是速度的积分。爬升末端和平飞起点都是巡航速度，平飞末端和降落起点也一样，镜头不会在交界处急停再猛冲。
  const r = clamp(ratio, 0, 1);
  let covered;
  if (r <= CLIMB_SHARE) {
    covered = CLIMB_SHARE * climbIntegral(r / CLIMB_SHARE);
  } else if (r >= 1 - DESCENT_SHARE) {
    const step = (r - (1 - DESCENT_SHARE)) / DESCENT_SHARE;
    covered = CLIMB_I + CRUISE_I + DESCENT_SHARE * descentIntegral(step);
  } else {
    const step = (r - CLIMB_SHARE) / CRUISE_SHARE;
    covered = CLIMB_I + CRUISE_SHARE * CRUISE_MPS * step;
  }
  return covered / SPEED_I;
}

function sampleTrack(track, pathT) {
  const target = clamp(pathT, 0, 1) * track.total;
  const { points, cum } = track;
  if (target <= 0) return points[0].slice();
  if (target >= track.total) return points[points.length - 1].slice();
  let high = 1;
  while (high < cum.length && cum[high] < target) high += 1;
  const left = high - 1;
  const right = Math.min(points.length - 1, high);
  const span = cum[right] - cum[left] || 1;
  const mix = (target - cum[left]) / span;
  const a = points[left];
  const b = points[right];
  return [
    a[0] + (b[0] - a[0]) * mix,
    a[1] + (b[1] - a[1]) * mix,
    a[2] + (b[2] - a[2]) * mix,
  ];
}

function courseHeading(from, to) {
  const east = (to[0] - from[0]) * Math.cos(((from[1] + to[1]) / 2) * Math.PI / 180);
  const north = to[1] - from[1];
  if (Math.hypot(east, north) < 1e-10) return NaN;
  return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
}

function meters(a, b) {
  const x = (a[0] - b[0]) * 111320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  const y = (a[1] - b[1]) * 110540;
  return Math.hypot(x, y);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

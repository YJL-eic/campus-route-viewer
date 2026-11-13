const EMPTY = { type: "FeatureCollection", features: [] };

const POP_YELLOW = ["#fff8d6", "#ffe14a", "#f5c400", "#e0a100", "#c48400"];
const VEG_GREEN = ["#d9f0d3", "#a6dba0", "#5aae61", "#1b7837", "#00441b"];

export function createLocaView(Loca, loca, nofly, campuses = []) {
  const lights = setupMultiLights(Loca, loca, campuses);

  // 文档「高效数据源」：每层独立 GeoBufferSource（GeoBuf/PBF），约 GeoJSON 体积的 1/4。
  const zones = new Loca.PolygonLayer({
    zIndex: 125,
    opacity: 0.9,
    shininess: 18,
    hasSide: true,
    hasTop: true,
    depth: false,
    cullface: "none",
    acceptLight: true,
    visible: true,
    zooms: [2, 22],
  });
  zones.setSource(new Loca.GeoJSONSource({ data: nofly }));
  zones.setStyle({
    topColor: (_index, feature) => (
      feature.properties.layer === "building_obstacle" ? "rgba(160,80,110,0.72)" : "rgba(220,70,70,0.58)"
    ),
    sideColor: "rgba(200,70,70,0.45)",
    sideTopColor: "rgba(200,70,70,0.45)",
    sideBottomColor: "rgba(200,70,70,0.2)",
    height: 40,
    altitude: 12,
  });

  const heat = heatLayer(Loca, 128, efficientSource(Loca, "/data/population.pbf"), {
    radius: 1000,
    height: 180,
    gradient: {
      0.15: "#fff4b8",
      0.45: "#ffe14a",
      0.75: "#f5c400",
      1: "#e0a100",
    },
  });

  const veg = heatLayer(Loca, 127, efficientSource(Loca, "/data/vegetation.pbf"), {
    radius: 900,
    height: 160,
    gradient: {
      0.2: "#d9f0d3",
      0.55: "#5aae61",
      1: "#1b7837",
    },
  });

  const popHex = hexLayer(Loca, 129, efficientSource(Loca, "/data/population.pbf"), POP_YELLOW, 280);
  const vegHex = hexLayer(Loca, 126, efficientSource(Loca, "/data/vegetation.pbf"), VEG_GREEN, 280);
  // 丰舟90 V2 终端空域：R25/R50 柱体 + 南北走廊 + 160/210 保护带。
  const pads = createTerminalPadLayers(Loca, campuses);
  // 高德 Loca 贴地呼吸红圈（官方 breath_red 序列帧）。
  const breath = createBreathMarkers(Loca, campuses);

  const pulse = new Loca.PulseLineLayer({
    zIndex: 140,
    opacity: 1,
    visible: false,
    zooms: [2, 22],
  });
  pulse.setSource(new Loca.GeoJSONSource({ data: EMPTY }));
  pulse.setStyle({
    altitude: 180,
    lineWidth: 8,
    headColor: "#ffe08a",
    trailColor: "rgba(14, 116, 144, 0.55)",
    interval: 0.25,
    duration: 5000,
  });

  // Overview / flight use Loca LineLayer with altitude (高层线路图).
  const plan = lineLayer(Loca, 132, "rgba(14, 116, 144, 0.35)");
  const trace = lineLayer(Loca, 146, "#c25a26");

  loca.add(heat);
  loca.add(veg);
  loca.add(popHex);
  loca.add(vegHex);
  loca.add(zones);
  pads.layers.forEach((layer) => loca.add(layer));
  if (breath.core) loca.add(breath.core);
  if (breath.ring) loca.add(breath.ring);
  loca.add(pulse);
  loca.add(plan);
  loca.add(trace);
  loca.animate.start();
  return { loca, zones, heat, veg, popHex, vegHex, pads, breath, lights, pulse, plan, trace };
}

/** 三校区起降点：贴地红点 + 官方呼吸红圈闪烁（ScatterLayer）。 */
function createBreathMarkers(Loca, campuses) {
  const list = campuses || [];
  if (!list.length || !Loca.ScatterLayer) return { core: null, ring: null };

  const source = new Loca.GeoJSONSource({
    data: {
      type: "FeatureCollection",
      features: list.map((campus) => ({
        type: "Feature",
        properties: { id: campus.id, name: campus.name },
        geometry: { type: "Point", coordinates: [campus.lon, campus.lat] },
      })),
    },
  });

  // 实心红芯，始终贴地可见。
  const core = new Loca.ScatterLayer({
    zIndex: 155,
    opacity: 1,
    visible: true,
    zooms: [2, 22],
  });
  core.setSource(source);
  core.setStyle({
    unit: "px",
    size: [14, 14],
    borderWidth: 2,
    borderColor: "#ffffff",
    color: "rgba(210, 40, 40, 0.95)",
    altitude: 0,
  });

  // 呼吸扩散圈：官方 demo 红圈序列帧。
  const ring = new Loca.ScatterLayer({
    zIndex: 154,
    opacity: 1,
    visible: true,
    zooms: [2, 22],
  });
  ring.setSource(source);
  ring.setStyle({
    unit: "px",
    size: [72, 72],
    borderWidth: 0,
    altitude: 0,
    animate: true,
    duration: 900,
    texture: "https://a.amap.com/Loca/static/loca-v2/demos/images/breath_red.png",
  });

  return { core, ring };
}

function setupMultiLights(Loca, loca, campuses) {
  const lights = [];
  const add = (light) => {
    if (!light) return;
    if (typeof loca.addLight === "function") loca.addLight(light);
    lights.push(light);
  };

  if (Loca.AmbientLight) {
    add(new Loca.AmbientLight({ intensity: 0.42, color: "#ffffff" }));
  } else {
    loca.ambLight = { intensity: 0.42, color: "#ffffff" };
  }

  if (Loca.DirectionalLight) {
    add(new Loca.DirectionalLight({
      intensity: 0.7,
      color: "#abffc8",
      target: [0, 0, 0],
      position: [0, 3, 6],
    }));
    add(new Loca.DirectionalLight({
      intensity: 0.55,
      color: "#5d8cff",
      target: [0, 0, 0],
      position: [0, -8, 10],
    }));
  } else {
    loca.dirLight = {
      intensity: 0.7,
      color: "#ffffff",
      target: [0, 0, 0],
      position: [0, -1, 1],
    };
  }

  if (Loca.PointLight) {
    const palette = ["rgb(11,255,241)", "rgb(255,180,40)", "rgb(180,120,255)"];
    (campuses || []).forEach((campus, index) => {
      add(new Loca.PointLight({
        color: palette[index % palette.length],
        position: [campus.lon, campus.lat, 900],
        intensity: 8,
        distance: 9000,
      }));
    });
  }

  return lights;
}

/** Planning values from 终端空域平面与剖面.pptx (丰舟90 V2). */
const TERM = {
  rInner: 25,
  hInner: 60,
  rOuter: 50,
  hOuter: 80,
  convert: 300,
  convertH: 50,
  protectV: 10,
  wMin: 50,
  wMax: 200,
  expandRate: 0.125,
  len210: 4000,
  cruise210: 210,
  ramp210: 3200,
  len160: 3000,
  cruise160: 160,
  ramp160: 2200,
  join: 500,
};

function createTerminalPadLayers(Loca, campuses) {
  const list = campuses || [];
  if (!list.length) return { layers: [] };

  const corridor = polyVolume(Loca, 148, 0.42);
  corridor.setSource(new Loca.GeoJSONSource({ data: terminalCorridors(list) }));
  corridor.setStyle({
    topColor: "rgba(136,137,255,0.35)",
    sideColor: "rgba(136,137,255,0.55)",
    sideTopColor: "rgba(136,137,255,0.55)",
    sideBottomColor: "rgba(100,102,210,0.25)",
    height: 8,
    altitude: 4,
  });

  const band210 = polyVolume(Loca, 149, 0.55);
  band210.setSource(new Loca.GeoJSONSource({ data: terminalBands(list, TERM.cruise210, TERM.len210) }));
  band210.setStyle({
    topColor: "rgba(220,80,80,0.45)",
    sideColor: "rgba(220,80,80,0.55)",
    sideTopColor: "rgba(220,80,80,0.55)",
    sideBottomColor: "rgba(180,50,50,0.25)",
    altitude: (_index, feature) => feature.properties.altitude,
    height: (_index, feature) => feature.properties.height,
  });

  const band160 = polyVolume(Loca, 150, 0.55);
  band160.setSource(new Loca.GeoJSONSource({ data: terminalBands(list, TERM.cruise160, TERM.len160) }));
  band160.setStyle({
    topColor: "rgba(50,130,220,0.45)",
    sideColor: "rgba(50,130,220,0.55)",
    sideTopColor: "rgba(50,130,220,0.55)",
    sideBottomColor: "rgba(30,90,180,0.25)",
    altitude: (_index, feature) => feature.properties.altitude,
    height: (_index, feature) => feature.properties.height,
  });

  const outer = polyVolume(Loca, 151, 0.5);
  outer.setSource(new Loca.GeoJSONSource({ data: terminalCylinders(list, TERM.rOuter) }));
  outer.setStyle({
    topColor: "rgba(150,145,255,0.35)",
    sideColor: "rgba(150,145,255,0.55)",
    sideTopColor: "rgba(150,145,255,0.55)",
    sideBottomColor: "rgba(110,105,210,0.25)",
    height: TERM.hOuter,
    altitude: 6,
  });

  const inner = polyVolume(Loca, 152, 0.72);
  inner.setSource(new Loca.GeoJSONSource({ data: terminalCylinders(list, TERM.rInner) }));
  inner.setStyle({
    topColor: "rgba(194,190,255,0.7)",
    sideColor: "rgba(134,126,242,0.85)",
    sideTopColor: "rgba(134,126,242,0.85)",
    sideBottomColor: "rgba(100,95,210,0.4)",
    height: TERM.hInner,
    altitude: 8,
  });

  return { layers: [corridor, band210, band160, outer, inner] };
}

function polyVolume(Loca, zIndex, opacity) {
  return new Loca.PolygonLayer({
    zIndex,
    opacity,
    shininess: 16,
    acceptLight: true,
    hasSide: true,
    hasTop: true,
    depth: false,
    cullface: "none",
    visible: true,
    zooms: [2, 22],
  });
}

function terminalCylinders(campuses, radius) {
  return {
    type: "FeatureCollection",
    features: campuses.map((campus) => ({
      type: "Feature",
      properties: { id: campus.id, name: campus.name, kind: "cylinder", radius },
      geometry: {
        type: "Polygon",
        coordinates: [circleRing(campus.lon, campus.lat, radius, 36)],
      },
    })),
  };
}

function terminalCorridors(campuses) {
  return {
    type: "FeatureCollection",
    features: campuses.map((campus) => ({
      type: "Feature",
      properties: { id: campus.id, name: campus.name, kind: "corridor" },
      geometry: {
        type: "Polygon",
        coordinates: [corridorRing(campus.lon, campus.lat, -TERM.len210, TERM.len210)],
      },
    })),
  };
}

/** ±10 m vertical protection tube along N–S terminal (示意分段体). */
function terminalBands(campuses, cruiseH, halfLen) {
  const features = [];
  const step = 200;
  campuses.forEach((campus) => {
    for (let s0 = -halfLen; s0 < halfLen; s0 += step) {
      const s1 = Math.min(halfLen, s0 + step);
      const mid = (s0 + s1) / 2;
      const h = trackHeight(mid, cruiseH);
      const halfW = corridorWidth(mid) / 2;
      features.push({
        type: "Feature",
        properties: {
          id: campus.id,
          kind: "band",
          cruise: cruiseH,
          altitude: Math.max(4, h - TERM.protectV),
          height: TERM.protectV * 2,
        },
        geometry: {
          type: "Polygon",
          coordinates: [segmentRect(campus.lon, campus.lat, s0, s1, halfW)],
        },
      });
    }
  });
  return { type: "FeatureCollection", features };
}

function trackHeight(s, cruiseH) {
  const abs = Math.abs(s);
  if (abs <= TERM.convert) return TERM.convertH;
  const rampEnd = TERM.convert + (cruiseH - TERM.convertH) * 20;
  if (abs < rampEnd) return TERM.convertH + (abs - TERM.convert) / 20;
  return cruiseH;
}

function corridorWidth(s) {
  return Math.min(TERM.wMin + TERM.expandRate * Math.abs(s), TERM.wMax);
}

function corridorRing(lon, lat, sMin, sMax, samples = 48) {
  const left = [];
  const right = [];
  for (let i = 0; i <= samples; i += 1) {
    const s = sMin + ((sMax - sMin) * i) / samples;
    const halfW = corridorWidth(s) / 2;
    left.push(projectOffset(lon, lat, -halfW, s, 0));
    right.push(projectOffset(lon, lat, halfW, s, 0));
  }
  return [...left, ...right.reverse(), left[0]];
}

function segmentRect(lon, lat, s0, s1, halfW) {
  return [
    projectOffset(lon, lat, -halfW, s0, 0),
    projectOffset(lon, lat, halfW, s0, 0),
    projectOffset(lon, lat, halfW, s1, 0),
    projectOffset(lon, lat, -halfW, s1, 0),
    projectOffset(lon, lat, -halfW, s0, 0),
  ];
}

function circleRing(lon, lat, radius, steps = 32) {
  const ring = [];
  for (let step = 0; step <= steps; step += 1) {
    const theta = (step / steps) * Math.PI * 2;
    ring.push(projectOffset(lon, lat, Math.cos(theta) * radius, Math.sin(theta) * radius, 0));
  }
  return ring;
}

function projectOffset(lon, lat, eastM, northM, angleDeg = 0) {
  const rad = (angleDeg * Math.PI) / 180;
  const xr = eastM * Math.cos(rad) - northM * Math.sin(rad);
  const yr = eastM * Math.sin(rad) + northM * Math.cos(rad);
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const mLat = 110540;
  return [lon + xr / mLon, lat + yr / mLat];
}

/** Loca 高效数据源 GeoBufferSource；若运行时不可用则回退到同名 geojson。 */
function efficientSource(Loca, pbfUrl) {
  if (Loca.GeoBufferSource) {
    return new Loca.GeoBufferSource({ url: pbfUrl });
  }
  const geoUrl = pbfUrl.replace(/\.pbf$/i, ".geojson");
  return new Loca.GeoJSONSource({ url: geoUrl });
}

function heatLayer(Loca, zIndex, source, style) {
  const layer = new Loca.HeatMapLayer({
    zIndex,
    opacity: 0.95,
    visible: false,
    zooms: [2, 22],
  });
  layer.setSource(source);
  layer.setStyle({
    radius: style.radius,
    unit: "meter",
    height: style.height || 160,
    gradient: style.gradient,
    value: (_index, feature) => feature.properties.w || 1,
    heightBezier: [0, 0.53, 0.37, 0.98],
  });
  return layer;
}

function hexLayer(Loca, zIndex, source, colors, radius) {
  const layer = new Loca.HexagonLayer({
    zIndex,
    opacity: 0.92,
    visible: false,
    zooms: [2, 22],
    acceptLight: true,
    hasSide: true,
    depth: false,
    cullface: "none",
  });
  layer.setSource(source);
  layer.setStyle({
    unit: "meter",
    radius,
    gap: 16,
    altitude: 20,
    value: (_index, feature) => cellWeight(feature),
    height: (_index, feature) => {
      const weight = feature.value ?? cellWeight(feature);
      const max = Math.max(feature.max || 0, weight, 1);
      return Math.max(60, Math.min(900, 40 + (weight / max) * 800));
    },
    topColor: (_index, feature) => colorByValue(feature, colors),
    sideColor: (_index, feature) => colorByValue(feature, colors),
    sideTopColor: (_index, feature) => colorByValue(feature, colors),
    sideBottomColor: (_index, feature) => colorByValue(feature, colors, 0.35),
  });
  return layer;
}

function lineLayer(Loca, zIndex, color) {
  const layer = new Loca.LineLayer({
    zIndex,
    opacity: 1,
    visible: false,
    zooms: [2, 22],
  });
  layer.setSource(new Loca.GeoJSONSource({ data: EMPTY }));
  layer.setStyle({
    color,
    lineWidth: 8,
    altitude: (_index, feature) => feature.properties.alt || 0,
  });
  return layer;
}

export function showFlyingLine(Loca, view, route) {
  if (!view) return;
  if (!route?.feasible || !route.cruise?.length) {
    view.pulse?.hide();
    return;
  }
  view.pulse.show();
  view.pulse.setSource(new Loca.GeoJSONSource({
    data: {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { height: route.height_m },
        geometry: {
          type: "LineString",
          coordinates: route.cruise.map((point) => [point[0], point[1]]),
        },
      }],
    },
  }));
  view.pulse.setStyle({
    altitude: route.height_m,
    lineWidth: 8,
    headColor: "#ffe08a",
    trailColor: "rgba(14, 116, 144, 0.45)",
    interval: 0.22,
    duration: 4500,
  });
  view.loca.animate.start();
}

export function showRouteProfile(Loca, view, route, mode = "overview") {
  if (!view?.plan) return null;
  if (!route?.feasible) {
    view.plan.hide();
    view.trace.hide();
    view.pulse?.hide();
    return null;
  }
  const profile = buildProfile(route);
  view.pulse?.hide();
  applyRouteMode(Loca, view, route, profile, mode);
  return profile;
}

/** 三校区闭环：把多段航迹叠到同一条高层线路上。 */
export function showLoopProfile(Loca, view, legs, mode = "overview") {
  if (!view?.plan) return null;
  const feasible = (legs || []).filter((leg) => leg?.feasible && leg.cruise?.length);
  if (!feasible.length) {
    view.plan.hide();
    view.trace.hide();
    view.pulse?.hide();
    return null;
  }
  const profiles = feasible.map((leg) => buildProfile(leg));
  const all = profiles.flatMap((profile) => profile.all);
  view.pulse?.hide();
  view.plan.show();
  view.plan.setSource(new Loca.GeoJSONSource({ data: lineData(all) }));
  if (mode === "overview") {
    view.trace.hide();
    view.trace.setSource(new Loca.GeoJSONSource({ data: EMPTY }));
    styleHighLine(view.plan, "#25CDEA", 10, OVERVIEW_Z);
  } else {
    view.trace.show();
    view.trace.setSource(new Loca.GeoJSONSource({ data: EMPTY }));
    styleHighLine(view.plan, "rgba(14, 116, 144, 0.35)", 8, FLIGHT_Z);
    styleHighLine(view.trace, "#c25a26", 8, FLIGHT_Z);
  }
  return { profiles, all, height: Math.max(...profiles.map((profile) => profile.height || 0)) };
}

export function setRouteViewMode(Loca, view, route, profile, mode) {
  if (!view || !route?.feasible || !profile) return;
  applyRouteMode(Loca, view, route, profile, mode);
}

function applyRouteMode(Loca, view, route, profile, mode) {
  view.pulse?.hide();
  view.plan.show();
  view.plan.setSource(new Loca.GeoJSONSource({ data: lineData(profile.all) }));
  if (mode === "overview") {
    view.trace.hide();
    view.trace.setSource(new Loca.GeoJSONSource({ data: EMPTY }));
    styleHighLine(view.plan, "#25CDEA", 10, OVERVIEW_Z);
    return;
  }
  view.trace.show();
  view.trace.setSource(new Loca.GeoJSONSource({ data: EMPTY }));
  styleHighLine(view.plan, "rgba(14, 116, 144, 0.35)", 8, FLIGHT_Z);
  styleHighLine(view.trace, "#c25a26", 8, FLIGHT_Z);
}

// 与高德建筑楼块同量级：按真实巡航高度（160/210 m）贴图，仅轻微抬升便于辨认。
const OVERVIEW_Z = 1.2;
const FLIGHT_Z = 1;

function styleHighLine(layer, color, lineWidth, zScale) {
  layer.setStyle({
    color,
    lineWidth,
    altitude: (_index, feature) => (feature.properties.alt || 0) * zScale,
  });
}

export function showFlownProfile(Loca, view, profile, frame) {
  if (!view?.trace || !profile || !frame) return;
  const points = flownPoints(profile, frame);
  if (points.length < 2) return;
  view.trace.setSource(new Loca.GeoJSONSource({ data: lineData(points) }));
}

export function setLayerMode(view, { showPop, showVeg, heatMode }) {
  if (!view) return;
  const hex = heatMode === "hex";
  view.heat?.[showPop && !hex ? "show" : "hide"]?.();
  view.popHex?.[showPop && hex ? "show" : "hide"]?.();
  view.veg?.[showVeg && !hex ? "show" : "hide"]?.();
  view.vegHex?.[showVeg && hex ? "show" : "hide"]?.();
  view.loca?.animate?.start();
}

export function craftPoint(profile, frame) {
  if (!profile || !frame?.point) return frame?.point;
  if (frame.phase === "climb") {
    return atFraction(profile.climb, (frame.point[2] || 0) / (profile.height || 1));
  }
  if (frame.phase === "descent") {
    return atFraction(profile.descent, 1 - (frame.point[2] || 0) / (profile.height || 1));
  }
  return frame.point;
}

function lineData(points) {
  const features = [];
  for (let index = 1; index < points.length; index += 1) {
    const end = points[index];
    features.push({
      type: "Feature",
      properties: { alt: end[2] || 0 },
      geometry: {
        type: "LineString",
        coordinates: [
          [points[index - 1][0], points[index - 1][1]],
          [end[0], end[1]],
        ],
      },
    });
  }
  return { type: "FeatureCollection", features };
}

function buildProfile(route) {
  const height = route.height_m || 0;
  const path = [[route.climb[0][0], route.climb[0][1]], ...route.cruise.map((point) => [point[0], point[1]])];
  const total = pathLength(path);
  const rampLen = Math.min(1400, Math.max(400, total * 0.16));
  const climb = rampPoints(path, 0, rampLen, height, true);
  const descent = rampPoints(path, Math.max(0, total - rampLen), total, height, false);
  const cruise = [];
  let walked = 0;
  route.cruise.forEach((point, index) => {
    const prev = index === 0 ? path[0] : route.cruise[index - 1];
    walked += meters(prev, point);
    if (walked > rampLen && total - walked > rampLen) cruise.push([point[0], point[1], height, index]);
  });
  if (!cruise.length) cruise.push([route.cruise[0][0], route.cruise[0][1], height, 0]);
  return {
    height,
    climb,
    cruise,
    descent,
    all: [...climb, ...cruise, ...descent],
  };
}

function rampPoints(path, start, end, height, rising) {
  const steps = 36;
  const span = Math.max(0, end - start);
  const points = [];
  for (let step = 0; step <= steps; step += 1) {
    const xy = pointAt(path, start + (step / steps) * span);
    const fraction = step / steps;
    points.push([xy[0], xy[1], (rising ? fraction : 1 - fraction) * height]);
  }
  return points;
}

function flownPoints(profile, frame) {
  if (frame.phase === "climb") {
    const limit = frame.point[2] || 0;
    const risen = profile.climb.filter((point) => point[2] <= limit + 1);
    return risen.length > 1 ? risen : profile.climb.slice(0, 2);
  }
  if (frame.phase === "descent") {
    const limit = frame.point[2] || 0;
    const dropped = profile.descent.filter((point) => point[2] >= limit - 1);
    return [...profile.climb, ...profile.cruise, ...dropped];
  }
  const index = frame.cruiseIndex || 0;
  const covered = profile.cruise.filter((point) => (point[3] || 0) <= index);
  return [...profile.climb, ...(covered.length ? covered : profile.cruise.slice(0, 1))];
}

function atFraction(points, fraction) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const cursor = clamped * (points.length - 1);
  const left = Math.floor(cursor);
  const right = Math.min(points.length - 1, left + 1);
  const mix = cursor - left;
  const a = points[left];
  const b = points[right];
  return [
    a[0] + (b[0] - a[0]) * mix,
    a[1] + (b[1] - a[1]) * mix,
    a[2] + (b[2] - a[2]) * mix,
  ];
}

function pointAt(path, distance) {
  let walked = 0;
  for (let index = 1; index < path.length; index += 1) {
    const step = meters(path[index - 1], path[index]);
    if (walked + step >= distance) {
      const mix = step ? (distance - walked) / step : 0;
      return [
        path[index - 1][0] + (path[index][0] - path[index - 1][0]) * mix,
        path[index - 1][1] + (path[index][1] - path[index - 1][1]) * mix,
      ];
    }
    walked += step;
  }
  const last = path[path.length - 1];
  return [last[0], last[1]];
}

function pathLength(path) {
  let total = 0;
  for (let index = 1; index < path.length; index += 1) total += meters(path[index - 1], path[index]);
  return total;
}

function meters(a, b) {
  const x = (a[0] - b[0]) * 111320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  const y = (a[1] - b[1]) * 110540;
  return Math.hypot(x, y);
}

function cellWeight(feature) {
  const items = feature.coordinates || [];
  if (!items.length && feature.properties?.w != null) return feature.properties.w;
  let total = 0;
  items.forEach((item) => {
    total += item.properties?.w || 1;
  });
  return total;
}

function colorByValue(feature, colors, alpha = 1) {
  const weight = feature.value ?? cellWeight(feature);
  const max = feature.max || weight || 1;
  const ratio = Math.max(0, Math.min(0.999, weight / max));
  const index = Math.floor(ratio * (colors.length - 1));
  const hex = colors[index];
  if (alpha >= 1) return hex;
  return hexToRgba(hex, alpha);
}

function hexToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  const full = value.length === 3
    ? value.split("").map((part) => part + part).join("")
    : value;
  const number = Number.parseInt(full, 16);
  const r = (number >> 16) & 255;
  const g = (number >> 8) & 255;
  const b = number & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

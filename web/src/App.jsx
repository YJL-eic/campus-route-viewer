import { useEffect, useMemo, useRef, useState } from "react";
import AMapLoader from "@amap/amap-jsapi-loader";
import {
  LOOP_EAST_CCW,
  LOOP_EAST_CW,
  LOOP_WEST_CCW,
  LOOP_WEST_CW,
  createLocaView,
  setLayerMode,
  setRouteViewMode,
  showDualLoopProfile,
  showFlownProfile,
  showFlyingLine,
  showLoopProfile,
  showRouteProfile,
} from "./locaView.js";
import { mountDrone } from "./droneModel.js";
import { buildBatterySeries, flightTelemetry, readSoc } from "./batteryCurve.js";
import { easeInOut, lerp, lerpAngle, poseOnTrack, prepareTrack } from "./flightSmooth.js";
import SiteDetail from "./SiteDetail.jsx";

const COCKPIT_MIN_MS = 62000;
const RECHARGE_MS = 2500;

export default function App() {
  const mapRef = useRef(null);
  const mapObj = useRef(null);
  const droneRef = useRef(null);
  const locaRef = useRef(null);
  const markersRef = useRef([]);
  const timer = useRef(0);
  const playback = useRef(null);
  const [meta, setMeta] = useState(null);
  const [mapError, setMapError] = useState("");
  const [origin, setOrigin] = useState("west");
  const [dest, setDest] = useState("junshan");
  const [nofly, setNofly] = useState(true);
  const [pop, setPop] = useState(true);
  const [green, setGreen] = useState(true);
  const [windOn, setWindOn] = useState(false);
  const [windCase, setWindCase] = useState("02");
  const [aircraft, setAircraft] = useState("20kg");
  const [showNofly, setShowNofly] = useState(true);
  const [showPop, setShowPop] = useState(false);
  const [showVeg, setShowVeg] = useState(false);
  const [heatMode, setHeatMode] = useState("heat");
  const [showBuildings, setShowBuildings] = useState(true);
  const [showSatellite, setShowSatellite] = useState(false);
  const [route, setRoute] = useState(null);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("idle");
  const [paused, setPaused] = useState(false);
  const [altitude, setAltitude] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [remainM, setRemainM] = useState(0);
  const [soc, setSoc] = useState(1);
  const [pad, setPad] = useState(null);
  const [viewpoint, setViewpoint] = useState("overview");
  const [menu, setMenu] = useState("");
  const [mapReady, setMapReady] = useState(false);
  const [flightMode, setFlightMode] = useState("leg"); // leg | loop
  const droneStop = useRef(null);
  const buildingsRef = useRef(null);
  const satelliteRef = useRef(null);
  const roadNetRef = useRef(null);
  const vectorBaseRef = useRef(null);
  const terrainRef = useRef(null);
  const profileRef = useRef(null);
  const loopRef = useRef(null);
  const flightModeRef = useRef("leg");
  const traceAt = useRef(0);
  const legPathRef = useRef([]);
  const viewpointRef = useRef("overview");
  const flyingRef = useRef(false);
  viewpointRef.current = viewpoint;
  flightModeRef.current = flightMode;

  const wind = windOn ? windCase : "00";
  const scenarioKey = `${Number(nofly)}${Number(pop)}${Number(green)}${wind}`;

  useEffect(() => {
    fetch("/data/meta.json").then((response) => response.json()).then(setMeta);
  }, []);

  useEffect(() => {
    if (!meta) return undefined;
    const key = import.meta.env.VITE_AMAP_KEY;
    const security = import.meta.env.VITE_AMAP_SECURITY;
    if (!key || !security) {
      setMapError("缺少高德密钥。请在 web/.env.local 中填写 VITE_AMAP_KEY 和 VITE_AMAP_SECURITY。");
      return undefined;
    }
    window._AMapSecurityConfig = { securityJsCode: security };
    let cancelled = false;
    AMapLoader.load({
      key,
      // 3D 地形图仅官方 2.1Beta 完整支持（对应 Android MapsInitializer.setTerrainEnable）
      version: "2.1Beta",
      plugins: ["AMap.Scale", "AMap.ToolBar", "AMap.Buildings"],
      Loca: { version: "2.0.0" },
    }).then(async (AMap) => {
      if (cancelled) return;
      const center = meta.campuses[0];
      const map = new AMap.Map(mapRef.current, {
        viewMode: "3D",
        terrain: true,
        pitch: 52,
        rotation: -20,
        zoom: 10.5,
        center: [center.lon, center.lat],
        showBuildingBlock: true,
        pitchEnable: true,
        rotateEnable: true,
      });
      map.addControl(new AMap.Scale());
      map.addControl(new AMap.ToolBar());
      mapObj.current = map;
      if (AMap.Buildings) {
        buildingsRef.current = new AMap.Buildings({
          zooms: [14, 20],
          zIndex: 100,
          heightFactor: 1.8,
          opacity: 0.96,
          wallColor: "rgba(186, 192, 202, 0.96)",
          roofColor: "rgba(236, 239, 243, 0.98)",
        });
        map.add(buildingsRef.current);
      }
      satelliteRef.current = new AMap.TileLayer.Satellite({ zIndex: 2, zooms: [3, 20] });
      roadNetRef.current = new AMap.TileLayer.RoadNet({ zIndex: 3, zooms: [3, 20] });
      const droneWrap = document.createElement("div");
      droneWrap.className = "drone-wrap";
      const droneCanvas = document.createElement("canvas");
      droneWrap.appendChild(droneCanvas);
      droneStop.current = mountDrone(droneCanvas);
      droneRef.current = new AMap.Marker({
        position: [center.lon, center.lat],
        content: droneWrap,
        offset: new AMap.Pixel(-36, -36),
        zIndex: 160,
      });
      map.add(droneRef.current);
      markersRef.current = meta.campuses.map((campus) => {
        const pin = document.createElement("div");
        pin.className = "pad-label";
        pin.textContent = padShortName(campus);
        pin.addEventListener("click", (event) => {
          event.stopPropagation();
          // 与示例一致：进入起降点 3D 详情页，不在主图上局部缩放。
          setPad(campus);
        });
        const marker = new AMap.Marker({
          position: [campus.lon, campus.lat],
          content: pin,
          offset: new AMap.Pixel(-28, -42),
          title: `${campus.name} · ${campus.site || "终端空域（示意）"}`,
          zIndex: 125,
        });
        return marker;
      });
      map.add(markersRef.current);
      fitPoints(map, AMap, meta.campuses.map((campus) => [campus.lon, campus.lat]));
      const LocaLib = window.Loca;
      if (!LocaLib) {
        setMapError("Loca 2.0 没有加载。");
        setMapReady(true);
        return;
      }
      const noflyData = await fetch("/data/nofly.geojson").then((response) => response.json());
      const loca = new LocaLib.Container({ map });
      // 人口/植被热力与蜂窝改用 Loca.GeoBufferSource（/data/*.pbf），不再整包拉取 GeoJSON。
      locaRef.current = createLocaView(LocaLib, loca, noflyData, meta.campuses);
      setMapReady(true);
    }).catch((error) => setMapError(String(error?.message || error)));
    return () => {
      cancelled = true;
      setMapReady(false);
      cancelAnimationFrame(timer.current);
      droneStop.current?.();
      mapObj.current?.destroy();
    };
  }, [meta]);

  useEffect(() => {
    const zones = locaRef.current?.zones;
    if (!zones) return;
    showNofly ? zones.show() : zones.hide();
  }, [showNofly, mapReady]);

  useEffect(() => {
    setLayerMode(locaRef.current, { showPop, showVeg, heatMode });
  }, [showPop, showVeg, heatMode, mapReady]);

  useEffect(() => {
    // 俯视/第一人称只改相机，不改航线图层；飞行中才切到实际高度航线。
    if (!route?.feasible || !profileRef.current || flyingRef.current) return;
    try {
      setRouteViewMode(window.Loca, locaRef.current, route, profileRef.current, "overview");
    } catch {
      // Loca layers may not be ready on the first paint.
    }
  }, [route, mapReady]);

  const cockpitFlight = viewpoint === "cockpit"
    && (phase === "climb" || phase === "cruise" || phase === "descent" || phase === "recharge");

  useEffect(() => {
    const map = mapObj.current;
    const AMap = window.AMap;
    if (!map || !AMap) return;
    if (!vectorBaseRef.current) {
      vectorBaseRef.current = new AMap.TileLayer({ zIndex: 1, zooms: [3, 20] });
    }
    if (!terrainRef.current) {
      terrainRef.current = map.getLayers().find((layer) => layer.CLASS_NAME === "AMap.NebulaLayer") || null;
    }
    const terrain = terrainRef.current;
    const vectorBase = vectorBaseRef.current;
    const buildings = buildingsRef.current;
    const satellite = satelliteRef.current;
    const roadNet = roadNetRef.current;
    const showCity = cockpitFlight && !showSatellite;
    const layers = () => map.getLayers();
    const put = (layer) => {
      if (layer && !layers().includes(layer)) map.add(layer);
    };
    const pull = (layer) => {
      if (layer && layers().includes(layer)) map.remove(layer);
    };
    map.setFeatures(["bg", "road", "building", "point"]);
    map.setStatus({ showBuildingBlock: true, showLabel: true });
    if (showCity) {
      pull(terrain);
      put(vectorBase);
    } else {
      pull(vectorBase);
      put(terrain);
    }
    if (showSatellite && satellite && roadNet) {
      put(satellite);
      put(roadNet);
    } else {
      pull(satellite);
      pull(roadNet);
    }
    if (buildings) {
      if (typeof buildings.setzIndex === "function") buildings.setzIndex(100);
      if (cockpitFlight || showBuildings) put(buildings);
      else pull(buildings);
    }
    markersRef.current.forEach((marker) => marker.show());
  }, [cockpitFlight, showBuildings, showSatellite, mapReady]);

  useEffect(() => {
    if (!cockpitFlight) return undefined;
    const refreshBuildings = () => {
      const map = mapObj.current;
      if (!map?.emit) return;
      map.emit("moveend");
    };
    const start = window.setTimeout(refreshBuildings, 700);
    const timer = window.setInterval(refreshBuildings, 1100);
    return () => {
      window.clearTimeout(start);
      window.clearInterval(timer);
    };
  }, [cockpitFlight]);

  async function showFullRoute() {
    const map = mapObj.current;
    const AMap = window.AMap;
    if (!map || !AMap || !meta) return;
    if (sameRouteCampus(origin, dest, meta.campuses)) return;
    setPad(null);
    setViewpoint("overview");
    stop();
    setPhase("idle");
    setProgress(0);
    setAltitude(0);
    setSpeed(0);
    setSoc(1);
    flyingRef.current = false;

    // 已展示闭环时再次点击 → 关闭并回到当前航段。
    if (flightModeRef.current === "loop") {
      loopRef.current = null;
      setFlightMode("leg");
      const data = await loadLeg(origin, dest, meta.campuses);
      setRoute(data);
      setRemainM(data.feasible ? data.distance_m : 0);
      profileRef.current = showRouteProfile(
        window.Loca,
        locaRef.current,
        data.feasible ? data : null,
        "overview",
      );
      if (!data.feasible) {
        showFlyingLine(window.Loca, locaRef.current, null);
        return;
      }
      legPathRef.current = data.cruise.map((point) => [point[0], point[1]]);
      moveDrone(data.climb[0], false);
      fitPoints(map, AMap, legPathRef.current);
      map.setPitch(58);
      map.setRotation(-18);
      return;
    }

    // 东西校区各一对闭环：西区逆红/顺蓝，东区逆橙/顺绿。
    const dual = await loadDualLoops(meta.campuses);
    loopRef.current = dual;
    setFlightMode("loop");
    setRoute(dual.summary);
    setRemainM(dual.summary.feasible ? dual.summary.distance_m : 0);
    if (!dual.summary.feasible) {
      showDualLoopProfile(window.Loca, locaRef.current, {});
      showFlyingLine(window.Loca, locaRef.current, null);
      return;
    }
    profileRef.current = paintQuadLoops(dual);
    legPathRef.current = dual.path;
    const start = dual.westCcw.legs[0]?.climb?.[0]
      || dual.eastCcw.legs[0]?.climb?.[0]
      || dual.westCw.legs[0]?.climb?.[0];
    moveDrone(start, false);
    fitPoints(map, AMap, dual.path);
    map.setPitch(58);
    map.setRotation(-22);
    if (map.getZoom() < 11) map.setZoom(11.2);
  }

  function paintQuadLoops(bundle) {
    return showDualLoopProfile(window.Loca, locaRef.current, {
      westCcwLegs: bundle.westCcw?.legs,
      westCwLegs: bundle.westCw?.legs,
      eastCcwLegs: bundle.eastCcw?.legs,
      eastCwLegs: bundle.eastCw?.legs,
    });
  }

  const samples = useMemo(
    () => (route?.feasible ? buildBatterySeries(route, aircraft, wind) : []),
    [route, aircraft, wind],
  );
  const socNow = phase === "idle" ? 1 : soc;
  const lowBattery = socNow < 0.2;

  async function loadLeg(from, to, campuses = meta?.campuses) {
    const fromId = routeCampusId(from, campuses);
    const toId = routeCampusId(to, campuses);
    const file = `/data/routes/n${Number(nofly)}_p${Number(pop)}_g${Number(green)}_w${wind}_${fromId}_${toId}.json`;
    const data = await fetch(file).then((response) => response.json());
    const fromPad = findCampus(from, campuses);
    const toPad = findCampus(to, campuses);
    return reanchorLeg(data, fromPad, toPad);
  }

  async function loadLoopByOrder(order, campuses = meta?.campuses) {
    const legs = [];
    for (let index = 0; index < order.length - 1; index += 1) {
      legs.push(await loadLeg(order[index], order[index + 1], campuses));
    }
    return assembleLoop(order, legs);
  }

  async function loadLoop(from, to, campuses) {
    const order = resolveLoopOrder(from, to, campuses);
    return loadLoopByOrder(order, campuses);
  }

  async function loadDualLoops(campuses) {
    const loops = meta?.loops || {};
    const westCcwOrder = loops.west_ccw || ["west", "tongji", "junshan", "west"];
    const westCwOrder = loops.west_cw || ["west", "junshan", "tongji", "west"];
    const eastCcwOrder = loops.east_ccw || ["east", "tongji", "junshan", "east"];
    const eastCwOrder = loops.east_cw || ["east", "junshan", "tongji", "east"];
    const [westCcw, westCw, eastCcw, eastCw] = await Promise.all([
      loadLoopByOrder(westCcwOrder, campuses),
      loadLoopByOrder(westCwOrder, campuses),
      loadLoopByOrder(eastCcwOrder, campuses),
      loadLoopByOrder(eastCwOrder, campuses),
    ]);
    const bundles = [westCcw, westCw, eastCcw, eastCw];
    const path = bundles.flatMap((bundle) => bundle.path || []);
    const allLegs = bundles.flatMap((bundle) => bundle.legs || []);
    const heights = [
      ...new Set(
        allLegs
          .filter((leg) => leg?.feasible)
          .map((leg) => leg.height_m)
          .filter(Boolean),
      ),
    ].sort((a, b) => b - a);
    const feasible = bundles.some((bundle) => bundle.summary?.feasible);
    const summary = {
      feasible,
      loop: true,
      dual: true,
      quad: true,
      order: westCcw.order,
      orderLabel: `西区 ${westCcw.summary?.orderLabel || ""} / ${westCw.summary?.orderLabel || ""} · 东区 ${eastCcw.summary?.orderLabel || ""} / ${eastCw.summary?.orderLabel || ""}`,
      reason: feasible
        ? undefined
        : (bundles.find((bundle) => !bundle.summary?.feasible)?.summary?.reason || "闭环中有不可飞航段"),
      distance_m: Math.max(...bundles.map((bundle) => bundle.summary?.distance_m || 0)),
      time_s: Math.max(...bundles.map((bundle) => bundle.summary?.time_s || 0)),
      height_m: heights[0] || 0,
      heights,
      heightLabel: heights.length > 1 ? heights.join(" / ") : String(heights[0] || 0),
      exposure_m: Math.max(...bundles.map((bundle) => bundle.summary?.exposure_m || 0)),
      green_ratio: bundles.reduce((sum, bundle) => sum + (bundle.summary?.green_ratio || 0), 0) / bundles.length,
      low_coverage_m: Math.max(...bundles.map((bundle) => bundle.summary?.low_coverage_m || 0)),
      climb: westCcw.legs?.[0]?.climb || eastCcw.legs?.[0]?.climb || [],
      cruise: path.map((point) => [point[0], point[1], heights[0] || 0]),
      descent: westCcw.legs?.[westCcw.legs.length - 1]?.descent || [],
    };
    return {
      westCcw,
      westCw,
      eastCcw,
      eastCw,
      // 兼容旧字段
      ccw: westCcw,
      cw: westCw,
      path,
      summary,
      legs: westCcw.legs,
      dual: true,
      quad: true,
    };
  }

  function stop() {
    cancelAnimationFrame(timer.current);
    playback.current = null;
    setPaused(false);
  }

  function playRoute(data, done, options = {}) {
    if (!data.feasible) {
      setRoute(data);
      setPhase("blocked");
      setProgress(0);
      showFlyingLine(window.Loca, locaRef.current, null);
      showRouteProfile(window.Loca, locaRef.current, null);
      done?.();
      return;
    }
    setRoute(data);
    flyingRef.current = true;
    profileRef.current = showRouteProfile(window.Loca, locaRef.current, data, "flight");
    if (!profileRef.current) showFlyingLine(window.Loca, locaRef.current, data);
    const track = prepareTrack(profileRef.current);
    traceAt.current = 0;
    legPathRef.current = data.cruise.map((point) => [point[0], point[1]]);
    moveDrone(data.climb[0], viewpointRef.current === "cockpit");
    const flightMs = viewpointRef.current === "cockpit"
      ? Math.max(COCKPIT_MIN_MS, data.distance_m * 2.6)
      : 32000;
    const series = buildBatterySeries(data, aircraft, wind);
    const tick = (now) => {
      const play = playback.current;
      if (!play || play.paused) return;
      const frameDt = Math.min(34, Math.max(0, now - play.frameAt));
      play.frameAt = now;
      play.clock += frameDt;
      const elapsed = play.clock;
      if (elapsed <= flightMs) {
        const ratio = Math.min(1, elapsed / flightMs);
        const pose = track
          ? poseOnTrack(track, ratio)
          : {
            point: data.climb[0],
            heading: 0,
            phase: "climb",
          };
        const headingError = play.heading == null
          ? 0
          : ((pose.heading - play.heading + 540) % 360) - 180;
        const headingStep = Math.max(-4.5, Math.min(4.5, headingError));
        const heading = play.heading == null
          ? pose.heading
          : (play.heading + headingStep + 360) % 360;
        play.heading = heading;
        moveDrone(pose.point, viewpointRef.current === "cockpit");
        if (now - traceAt.current > 180) {
          traceAt.current = now;
          const fakeFrame = {
            phase: pose.phase,
            point: pose.point,
            cruiseIndex: Math.floor((pose.pathT || 0) * (data.cruise.length - 1)),
          };
          showFlownProfile(window.Loca, locaRef.current, profileRef.current, fakeFrame);
        }
        aimFollow(pose.point, heading, pose.point[2] || 0, data.height_m, ratio, play);
        const alt = Math.max(0, Math.round(pose.point[2] || 0));
        const telem = flightTelemetry(data, pose.phase, ratio, alt);
        if (now - (play.hudAt || 0) > 80) {
          play.hudAt = now;
          setAltitude(alt);
          setSpeed(telem.speed);
          setRemainM(telem.remain_m);
          setProgress(ratio);
          setPhase(pose.phase);
          setSoc(readSoc(series, ratio));
        }
        timer.current = requestAnimationFrame(tick);
        return;
      }
      const recharge = elapsed - flightMs;
      if (recharge <= RECHARGE_MS) {
        const endSoc = Math.max(0, readSoc(series, 1));
        setPhase("recharge");
        setSpeed(0);
        setRemainM(0);
        setSoc(endSoc + (1 - endSoc) * (recharge / RECHARGE_MS));
        setProgress(1);
        timer.current = requestAnimationFrame(tick);
        return;
      }
      playback.current = null;
      flyingRef.current = false;
      setPaused(false);
      setAltitude(0);
      setSpeed(0);
      setRemainM(0);
      setSoc(1);
      setPhase("done");
      if (!options.silentEnd) {
        if (viewpointRef.current === "overview" && profileRef.current) {
          setRouteViewMode(window.Loca, locaRef.current, data, profileRef.current, "overview");
        }
        restoreOverview();
      }
      play.done?.();
    };
    playback.current = {
      started: performance.now(),
      frameAt: performance.now(),
      clock: 0,
      elapsed: 0,
      paused: false,
      tick,
      done,
    };
    setPaused(false);
    timer.current = requestAnimationFrame(tick);
  }

  async function playLoop(bundle) {
    const legs = bundle.legs || [];
    let aborted = false;
    for (let index = 0; index < legs.length; index += 1) {
      const last = index === legs.length - 1;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        playRoute(legs[index], () => {
          if (flyingRef.current === "aborted") aborted = true;
          resolve();
        }, { silentEnd: !last });
      });
      if (aborted) return;
    }
    loopRef.current = bundle;
    setFlightMode("loop");
    setRoute(bundle.summary);
    if (bundle.dual && (bundle.westCcw || bundle.ccw)) {
      profileRef.current = paintQuadLoops(bundle);
      legPathRef.current = bundle.path;
    } else {
      profileRef.current = showLoopProfile(window.Loca, locaRef.current, bundle.legs, "overview");
      legPathRef.current = bundle.path;
    }
    restoreOverview();
  }

  function pauseFlight() {
    const play = playback.current;
    if (!play) return;
    if (play.paused) {
      play.paused = false;
      play.frameAt = performance.now();
      setPaused(false);
      timer.current = requestAnimationFrame(play.tick);
      return;
    }
    play.paused = true;
    cancelAnimationFrame(timer.current);
    setPaused(true);
  }

  function endFlight() {
    cancelAnimationFrame(timer.current);
    const pendingDone = playback.current?.done;
    playback.current = null;
    flyingRef.current = false;
    setPaused(false);
    setPhase("idle");
    setProgress(0);
    setAltitude(0);
    setSpeed(0);
    setRemainM(0);
    setSoc(1);
    if (flightModeRef.current === "loop" && loopRef.current?.summary?.feasible) {
      const bundle = loopRef.current;
      setRoute(bundle.summary);
      if (bundle.dual && (bundle.westCcw || bundle.ccw)) {
        profileRef.current = paintQuadLoops(bundle);
        legPathRef.current = bundle.path;
        moveDrone(
          bundle.westCcw?.legs?.[0]?.climb?.[0]
            || bundle.ccw?.legs?.[0]?.climb?.[0]
            || bundle.legs?.[0]?.climb?.[0],
          false,
        );
      } else {
        profileRef.current = showLoopProfile(window.Loca, locaRef.current, bundle.legs, "overview");
        legPathRef.current = bundle.path;
        moveDrone(bundle.legs[0].climb[0], false);
      }
    } else {
      const current = route;
      if (current?.feasible && !current.loop) {
        profileRef.current = showRouteProfile(window.Loca, locaRef.current, current, "overview");
        moveDrone(current.climb[0], false);
      }
    }
    restoreOverview();
    // 解除 playLoop 等待，并标记中止，避免继续下一段。
    flyingRef.current = "aborted";
    pendingDone?.();
    flyingRef.current = false;
  }

  function moveDrone(point, cockpit) {
    const marker = droneRef.current;
    if (!marker || !point) return;
    marker.setPosition([point[0], point[1]]);
    if (typeof marker.setAltitude === "function") marker.setAltitude(point[2] || 0);
    if (cockpit) {
      marker.hide();
      return;
    }
    marker.show();
    marker.getContent().className = "drone-wrap";
    marker.setOffset(new window.AMap.Pixel(-36, -36));
  }

  function aimFollow(point, heading, altitude, cruiseHeight, ratio, play) {
    const map = mapObj.current;
    if (!map) return;
    const raised = cruiseHeight > 0 ? Math.min(1, altitude / cruiseHeight) : 1;
    const cockpit = viewpointRef.current === "cockpit";
    const climbBlend = ratio < 0.2 ? easeInOut(ratio / 0.2) : 1;
    const descentBlend = ratio > 0.8 ? easeInOut((ratio - 0.8) / 0.2) : 0;
    let target;
    if (cockpit) {
      // 相机在机体上、朝航向看。地图中心放在机头前方，距离等于镜头后退量。
      const pitch = 72;
      const zoom = 17.2;
      const ahead = lookAheadMeters(pitch, zoom, point[1]);
      const look = shiftBy(point, heading, ahead);
      target = {
        pitch,
        zoom,
        rotation: (360 - heading) % 360,
        lng: look[0],
        lat: look[1],
      };
    } else {
      // Stay with the craft; ease zoom out after climb instead of jumping to full route bounds.
      const zoom = lerp(16.6, 12.8, Math.max(climbBlend * raised, descentBlend * 0.35));
      const pitch = lerp(60, 50, climbBlend * raised);
      target = {
        pitch,
        zoom,
        rotation: (360 - heading) % 360,
        lng: point[0],
        lat: point[1],
      };
    }
    const cam = play.cam || target;
    // 第一人称镜头锁在机体速度上，不再滞后追赶，交界处才不会一顿一冲。
    const follow = cockpit ? 1 : 0.1;
    cam.pitch = lerp(cam.pitch, target.pitch, follow);
    cam.zoom = lerp(cam.zoom, target.zoom, follow);
    cam.rotation = lerpAngle(cam.rotation, target.rotation, follow);
    cam.lng = lerp(cam.lng, target.lng, follow);
    cam.lat = lerp(cam.lat, target.lat, follow);
    play.cam = cam;
    if (!play.viewLocked) {
      play.viewLocked = true;
      map.setStatus({ animateEnable: false });
    }
    const zoom = Math.round(cam.zoom * 50) / 50;
    const pitch = Math.round(cam.pitch * 2) / 2;
    if (play.viewZoom !== zoom) {
      play.viewZoom = zoom;
      map.setZoom(zoom);
    }
    if (play.viewPitch !== pitch) {
      play.viewPitch = pitch;
      map.setPitch(pitch);
    }
    map.setRotation(cam.rotation);
    map.setCenter([cam.lng, cam.lat]);
  }

  function restoreOverview() {
    const map = mapObj.current;
    if (!map || viewpointRef.current === "cockpit") return;
    map.setStatus({ animateEnable: true });
    map.setPitch(58);
    map.setRotation(-18);
    if (legPathRef.current.length) fitPoints(map, window.AMap, legPathRef.current);
  }

  async function playSelection() {
    stop();
    if (flightModeRef.current === "loop") {
      const dual = loopRef.current?.dual
        ? loopRef.current
        : await loadDualLoops(meta.campuses);
      loopRef.current = dual;
      setFlightMode("loop");
      // 环飞按当前起点→终点选定的方向飞一条闭环，结束后仍恢复双色双闭环。
      const flyBundle = await loadLoop(origin, dest, meta.campuses);
      if (!flyBundle.summary.feasible) {
        setRoute(dual.summary);
        setPhase("blocked");
        return;
      }
      await playLoop({
        ...flyBundle,
        dual: true,
        quad: true,
        westCcw: dual.westCcw,
        westCw: dual.westCw,
        eastCcw: dual.eastCcw,
        eastCw: dual.eastCw,
        ccw: dual.westCcw,
        cw: dual.westCw,
        path: dual.path,
        summary: dual.summary,
      });
      return;
    }
    const data = await loadLeg(origin, dest);
    playRoute(data);
  }

  useEffect(() => {
    if (!meta || !mapReady) return undefined;
    if (sameRouteCampus(origin, dest, meta.campuses)) {
      stop();
      setRoute(null);
      setFlightMode("leg");
      loopRef.current = null;
      setPhase("idle");
      setProgress(0);
      showRouteProfile(window.Loca, locaRef.current, null);
      showFlyingLine(window.Loca, locaRef.current, null);
      return undefined;
    }
    let cancelled = false;
    stop();
    setFlightMode("leg");
    loopRef.current = null;
    setPhase("idle");
    setProgress(0);
    setAltitude(0);
    setSpeed(0);
    setRemainM(0);
    setSoc(1);
    loadLeg(origin, dest).then((data) => {
      if (cancelled) return;
      setRoute(data);
      setRemainM(data.feasible ? data.distance_m : 0);
      flyingRef.current = false;
      profileRef.current = showRouteProfile(
        window.Loca,
        locaRef.current,
        data.feasible ? data : null,
        "overview",
      );
      if (!data.feasible) {
        showFlyingLine(window.Loca, locaRef.current, null);
        return;
      }
      legPathRef.current = data.cruise.map((point) => [point[0], point[1]]);
      moveDrone(data.climb[0], false);
      if (!flyingRef.current && viewpointRef.current === "overview") {
        const map = mapObj.current;
        map?.setStatus({ animateEnable: true });
        fitPoints(map, window.AMap, legPathRef.current);
        map?.setPitch(58);
        map?.setRotation(-18);
      }
    });
    return () => {
      cancelled = true;
    };
    // Load the selected route for the charts. Flight starts only from the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioKey, origin, dest, meta, mapReady]);

  useEffect(() => {
    if (!menu) return undefined;
    const close = (event) => {
      if (!event.target.closest(".menu")) setMenu("");
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const flying = phase === "climb" || phase === "cruise" || phase === "descent" || phase === "recharge";
  const sameCampus = sameRouteCampus(origin, dest, meta?.campuses || []);
  const canStart = !sameCampus && !flying && !paused;
  const profileScale = route?.dual ? 210 : (route?.height_m || 210);
  const heightDot = profileDot(progress, route?.height_m || profileScale, profileScale);

  const phaseLabel = {
    climb: "爬升",
    cruise: "平飞",
    descent: "降落",
    recharge: "补能",
    done: "本段结束",
    blocked: "不可飞",
    idle: "待飞",
  }[phase] || "待飞";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <p>丰舟 90</p>
          <h1>三校区航路</h1>
        </div>
        <div className="route-bar">
          <label className="field">
            <span>起点</span>
            <select value={origin} onChange={(event) => setOrigin(event.target.value)}>
              {(meta?.campuses || []).map((campus) => (
                <option key={`from-${campus.id}`} value={campus.id}>{padShortName(campus)}</option>
              ))}
            </select>
          </label>
          <span className="route-arrow" aria-hidden="true">→</span>
          <label className="field">
            <span>终点</span>
            <select value={dest} onChange={(event) => setDest(event.target.value)}>
              {(meta?.campuses || []).map((campus) => (
                <option key={`to-${campus.id}`} value={campus.id}>{padShortName(campus)}</option>
              ))}
            </select>
          </label>
          {!sameCampus && <span className="route-split" aria-hidden="true" />}
          {!sameCampus && (
            <div className="group view-toggle">
              <button className={viewpoint === "overview" ? "active" : ""} onClick={() => setViewpoint("overview")}>俯视</button>
              <button className={viewpoint === "cockpit" ? "active" : ""} onClick={() => setViewpoint("cockpit")}>第一人称</button>
            </div>
          )}
        </div>
        <div className="flight-actions">
          <button className="play start" disabled={!canStart} onClick={playSelection}>
            {flying ? "飞行中" : (flightMode === "loop" ? "环飞闭环" : "开始飞行")}
          </button>
          <button className="ghost" disabled={!flying} onClick={pauseFlight}>{paused ? "继续" : "暂停"}</button>
          <button className="ghost" disabled={!flying} onClick={endFlight}>结束</button>
        </div>
        <div className="tool-row">
          <div className="tool-cluster">
            <span className="tool-label">约束</span>
            <div className="group">
              <button className={nofly ? "active" : ""} onClick={() => setNofly((value) => !value)}>禁飞</button>
              <button className={pop ? "active" : ""} onClick={() => setPop((value) => !value)}>人口</button>
              <button className={green ? "active" : ""} onClick={() => setGreen((value) => !value)}>绿地</button>
              <button className={windOn ? "active" : ""} onClick={() => setWindOn((value) => !value)}>风场</button>
            </div>
            {windOn && (
              <div className="group">
                <button className={windCase === "01" ? "active" : ""} onClick={() => setWindCase("01")}>低风</button>
                <button className={windCase === "02" ? "active" : ""} onClick={() => setWindCase("02")}>中风</button>
                <button className={windCase === "03" ? "active" : ""} onClick={() => setWindCase("03")}>高风</button>
              </div>
            )}
            {!nofly && <p className="warn">禁飞已关闭，只作对照</p>}
            <div className="group">
              <button className={aircraft === "20kg" ? "active" : ""} onClick={() => setAircraft("20kg")}>20 kg</button>
              <button className={aircraft === "10kg" ? "active" : ""} onClick={() => setAircraft("10kg")}>10 kg</button>
            </div>
          </div>
          <div className="tool-cluster">
            <span className="tool-label">图层</span>
            <div className="menu layer-menu">
              <button className="menu-trigger" onClick={() => setMenu(menu === "layer" ? "" : "layer")}>
                {layerLabel(showSatellite, showBuildings, showNofly, showPop, showVeg, heatMode)}
              </button>
              {menu === "layer" && (
                <div className="menu-panel">
                  <div className="group">
                    <button className={showSatellite ? "active" : ""} onClick={() => setShowSatellite((value) => !value)}>卫星</button>
                    <button className={showBuildings ? "active" : ""} onClick={() => setShowBuildings((value) => !value)}>建筑</button>
                    <button className={showNofly ? "active" : ""} onClick={() => setShowNofly((value) => !value)}>禁飞区</button>
                    <button className={showPop ? "active" : ""} onClick={() => setShowPop((value) => !value)}>人口</button>
                    <button className={showVeg ? "active" : ""} onClick={() => setShowVeg((value) => !value)}>植被</button>
                  </div>
                  <div className="group">
                    <button className={heatMode === "heat" ? "active" : ""} onClick={() => setHeatMode("heat")}>热力</button>
                    <button className={heatMode === "hex" ? "active" : ""} onClick={() => setHeatMode("hex")}>蜂窝</button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <button
            className={`ghost loop${flightMode === "loop" ? " active" : ""}`}
            disabled={!mapReady || sameCampus}
            onClick={showFullRoute}
          >
            {flightMode === "loop" ? "关闭闭环" : "航路闭环"}
          </button>
        </div>
      </header>
      <aside className="panel">
        <section className="card summary">
          <div className="summary-head">
            <h2>{flightMode === "loop" || route?.loop ? "闭环" : "本段"}</h2>
            {route?.feasible && !sameCampus && (
              <span className="summary-route">
                {padShortName(findCampus(origin, meta?.campuses))}
                <span aria-hidden="true">→</span>
                {padShortName(findCampus(dest, meta?.campuses))}
              </span>
            )}
          </div>
          {sameCampus && <p className="note">起点和终点需要落在不同校区航路节点（东/西区同属主校区）。</p>}
          {!sameCampus && !route && <p className="note">正在读取这条航段。</p>}
          {route?.feasible === false && <p className="warn">{route.reason}</p>}
          {route?.feasible && (
            <>
              {route.loop && route.orderLabel && (
                <p className="note">方向：{route.orderLabel}</p>
              )}
              {route.dual && (
                <p className="note">同 OD 对向段高度差：{route.heightLabel || "210 / 160"} 米</p>
              )}
              <dl className="metrics">
                <div className="metric hero">
                  <dt>航程</dt>
                  <dd>{(route.distance_m / 1000).toFixed(2)}<small>km</small></dd>
                </div>
                <div className="metric hero">
                  <dt>飞行</dt>
                  <dd>{(route.time_s / 60).toFixed(1)}<small>分</small></dd>
                </div>
                <div className="metric">
                  <dt>高度</dt>
                  <dd>{route.heightLabel || route.height_m}<small>米</small></dd>
                </div>
                <div className="metric">
                  <dt>暴露</dt>
                  <dd>{(route.exposure_m / 1000).toFixed(2)}</dd>
                </div>
                <div className="metric">
                  <dt>植被</dt>
                  <dd>{(route.green_ratio * 100).toFixed(0)}<small>%</small></dd>
                </div>
                <div className="metric">
                  <dt>低覆盖</dt>
                  <dd>{(route.low_coverage_m / 1000).toFixed(1)}<small>km</small></dd>
                </div>
              </dl>
            </>
          )}
        </section>
        <section className="card chart-card">
          <div className="summary-head">
            <h2>高度剖面</h2>
            {route?.feasible && (
              <span className="chart-readout">
                {phase === "idle" ? (route.heightLabel || route.height_m) : altitude}
                <small>米</small>
              </span>
            )}
          </div>
          <svg className="chart" viewBox="0 0 320 112" role="img" aria-label="高度剖面">
            {route?.feasible && (
              <>
                <defs>
                  <linearGradient id="altFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#1a5eff" stopOpacity="0.28" />
                    <stop offset="100%" stopColor="#1a5eff" stopOpacity="0.02" />
                  </linearGradient>
                  <linearGradient id="altFillHigh" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={LOOP_WEST_CCW} stopOpacity="0.2" />
                    <stop offset="100%" stopColor={LOOP_WEST_CCW} stopOpacity="0.02" />
                  </linearGradient>
                  <linearGradient id="altFillLow" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={LOOP_WEST_CW} stopOpacity="0.22" />
                    <stop offset="100%" stopColor={LOOP_WEST_CW} stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                {[profileScale, Math.round(profileScale / 2), 0].map((mark) => {
                  const y = altitudeY(mark, profileScale);
                  return (
                    <g key={mark}>
                      <line
                        x1={ALT.left}
                        y1={y}
                        x2={ALT.right}
                        y2={y}
                        stroke={mark === 0 ? "#d5dce8" : "#e4eaf3"}
                        strokeDasharray={mark === 0 ? undefined : "3 4"}
                      />
                      <text x={ALT.left - 8} y={y + 3} textAnchor="end" fontSize="10" fill="#8b93a3">{mark}</text>
                    </g>
                  );
                })}
                {route.dual ? (
                  <>
                    <polygon points={heightProfilePoints(210, 210)} fill="url(#altFillHigh)" />
                    <polygon points={heightProfilePoints(160, 210)} fill="url(#altFillLow)" />
                    <polyline points={heightProfilePoints(210, 210)} fill="none" stroke={LOOP_WEST_CCW} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
                    <polyline points={heightProfilePoints(160, 210)} fill="none" stroke={LOOP_WEST_CW} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
                  </>
                ) : (
                  <>
                    <polygon points={heightProfilePoints(route.height_m, profileScale)} fill="url(#altFill)" />
                    <polyline points={heightProfilePoints(route.height_m, profileScale)} fill="none" stroke="#1a5eff" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
                  </>
                )}
                <circle cx={heightDot.x} cy={heightDot.y} r="6" fill="#ffffff" />
                <circle cx={heightDot.x} cy={heightDot.y} r="3.2" fill="#1a5eff" />
              </>
            )}
          </svg>
          {route?.feasible && (route.dual ? (
            <div className="chart-legend">
              <span><i style={{ background: LOOP_WEST_CCW }} />对向高层 210 米</span>
              <span><i style={{ background: LOOP_WEST_CW }} />对向低层 160 米</span>
            </div>
          ) : (
            <div className="chart-phases">
              <span>爬升</span>
              <span>平飞 {(route.distance_m / 1000).toFixed(1)} km</span>
              <span>降落</span>
            </div>
          ))}
        </section>
        <section className="card chart-card">
          <div className="summary-head">
            <h2>电量</h2>
            <span className={`chart-readout soc${lowBattery && phase !== "idle" ? " warn" : ""}`}>
              {Math.round(socNow * 100)}
              <small>%</small>
            </span>
          </div>
          <svg className="chart" viewBox="0 0 320 112" role="img" aria-label="电量曲线">
            <defs>
              <linearGradient id="socFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#0e7490" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#0e7490" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {[1, 0.6, 0.2].map((mark) => {
              const y = socY(mark);
              const alert = mark === 0.2;
              return (
                <g key={mark}>
                  <line
                    x1={SOC.left}
                    y1={y}
                    x2={SOC.right}
                    y2={y}
                    stroke={alert ? "#e7c3b6" : "#e4eaf3"}
                    strokeDasharray={alert ? "4 4" : "3 4"}
                  />
                  <text x={SOC.left - 8} y={y + 3} textAnchor="end" fontSize="10" fill={alert ? "#b3531e" : "#8b93a3"}>
                    {Math.round(mark * 100)}
                  </text>
                </g>
              );
            })}
            {samples.length > 0 && (
              <>
                <polygon points={chartArea(samples)} fill="url(#socFill)" />
                <polyline points={chartPoints(samples)} fill="none" stroke="#0e7490" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
              </>
            )}
            <circle cx={socX(progress)} cy={socY(socNow)} r="6" fill="#ffffff" />
            <circle cx={socX(progress)} cy={socY(socNow)} r="3.2" fill={lowBattery && phase !== "idle" ? "#c25a26" : "#0e7490"} />
          </svg>
          <div className="chart-phases">
            <span>爬升耗电高</span>
            <span>巡航平台区</span>
            <span>末端陡降</span>
          </div>
          {lowBattery && phase !== "idle" && <p className="warn">电量低于 20%。{socNow <= 0 ? "该航段超出可用航程。" : ""}</p>}
        </section>
      </aside>
      <div className="map-wrap">
        <div id="map" className="map" ref={mapRef} />
        {mapError && <div className="error">{mapError}</div>}
        {phase !== "idle" && (
          <div className="altimeter">
            <div>
              <small>{phaseLabel}</small>
              <strong>{altitude}</strong>
              <span>米</span>
            </div>
            <div>
              <small>速度</small>
              <strong>{speed}</strong>
              <span>m/s</span>
            </div>
            <div>
              <small>剩余</small>
              <strong>{(remainM / 1000).toFixed(2)}</strong>
              <span>km</span>
            </div>
            <div>
              <small>电量</small>
              <strong>{Math.round(socNow * 100)}</strong>
              <span>%</span>
            </div>
          </div>
        )}
        {viewpoint === "cockpit" && <div className="hud"><span /></div>}
        {(flightMode === "loop" || route?.dual) && (
          <div className="route-legend" aria-label="航路闭环图例">
            <div className="route-legend-item">
              <span className="swatch" style={{ background: LOOP_WEST_CCW }} />
              <span>西区逆时针 · 红</span>
            </div>
            <div className="route-legend-item">
              <span className="swatch" style={{ background: LOOP_WEST_CW }} />
              <span>西区顺时针 · 蓝</span>
            </div>
            <div className="route-legend-item">
              <span className="swatch" style={{ background: LOOP_EAST_CCW }} />
              <span>东区逆时针 · 橙</span>
            </div>
            <div className="route-legend-item">
              <span className="swatch" style={{ background: LOOP_EAST_CW }} />
              <span>东区顺时针 · 绿</span>
            </div>
            <div className="route-legend-note">同 OD 对向：210 m / 160 m</div>
          </div>
        )}
      </div>
      {pad && (
        <SiteDetail campus={pad} onBack={() => setPad(null)} />
      )}
    </div>
  );
}

function findCampus(padId, campuses = []) {
  return (campuses || []).find((campus) => campus.id === padId)
    || (campuses || []).find((campus) => (campus.routeId || campus.id) === padId)
    || null;
}

function routeCampusId(padId, campuses = []) {
  const hit = findCampus(padId, campuses);
  return hit?.routeId || padId;
}

function sameRouteCampus(origin, dest, campuses = []) {
  if (!origin || !dest) return true;
  if (origin === dest) return true;
  return routeCampusId(origin, campuses) === routeCampusId(dest, campuses);
}

function padShortName(campus) {
  if (!campus) return "";
  if (campus.id === "west") return "西区";
  if (campus.id === "east") return "东区";
  return campus.name.replace(/校区$/, "");
}

/** 主校区航路节点落到具体起降点：逆时针偏西区，顺时针偏东区。 */
function mainHubPad(hint, campuses = [], prefer = "west") {
  if (hint === "west" || hint === "east") return hint;
  const preferred = findCampus(prefer, campuses);
  if (preferred) return preferred.id;
  const anyMain = (campuses || []).find((campus) => (campus.routeId || campus.id) === "main");
  return anyMain?.id || "west";
}

/** 以「起点→终点」为第一段，第三人作为中转，构成三校区闭环（主校区落到东西起降点）。 */
function resolveLoopOrder(origin, dest, campuses = []) {
  const originRoute = routeCampusId(origin, campuses);
  const destRoute = routeCampusId(dest, campuses);
  const routeIds = [...new Set((campuses || []).map((campus) => campus.routeId || campus.id))];
  const thirdRoute = routeIds.find((id) => id !== originRoute && id !== destRoute) || routeIds[0];
  // 选西→军山/同济 时闭环经西区；选东→… 时经东区；否则按绕行方向默认。
  const prefer = origin === "east" || dest === "east" ? "east" : "west";
  const toPad = (routeId, hint) => (
    routeId === "main" ? mainHubPad(hint, campuses, prefer) : routeId
  );
  const a = toPad(originRoute, origin);
  const b = toPad(destRoute, dest);
  const c = toPad(thirdRoute, prefer);
  return [a, b, c, a];
}

/** 把预计算航段端点锚到实际起降点，使闭环分别经过西区/东区。 */
function reanchorLeg(leg, fromPad, toPad) {
  if (!leg?.feasible || !fromPad || !toPad || !leg.climb?.length || !leg.descent?.length) return leg;
  const oldFrom = leg.climb[0];
  const oldTo = leg.descent[leg.descent.length - 1];
  const dFrom = [fromPad.lon - oldFrom[0], fromPad.lat - oldFrom[1]];
  const dTo = [toPad.lon - oldTo[0], toPad.lat - oldTo[1]];
  const climb = leg.climb.map((point) => [fromPad.lon, fromPad.lat, point[2]]);
  const descent = leg.descent.map((point) => [toPad.lon, toPad.lat, point[2]]);
  const count = leg.cruise?.length || 0;
  const cruise = (leg.cruise || []).map((point, index) => {
    const t = count <= 1 ? 0 : index / (count - 1);
    return [
      point[0] + dFrom[0] * (1 - t) + dTo[0] * t,
      point[1] + dFrom[1] * (1 - t) + dTo[1] * t,
      point[2],
    ];
  });
  return {
    ...leg,
    origin: fromPad.id,
    dest: toPad.id,
    climb,
    cruise,
    descent,
  };
}

function campusShort(id) {
  return ({
    main: "主",
    west: "西",
    east: "东",
    junshan: "军山",
    tongji: "同济",
  })[id] || id;
}

function assembleLoop(order, legs) {
  const feasible = legs.every((leg) => leg?.feasible);
  const path = [];
  for (const leg of legs) {
    if (!leg?.cruise) continue;
    for (const point of leg.cruise) path.push([point[0], point[1]]);
  }
  const distance_m = legs.reduce((sum, leg) => sum + (leg.distance_m || 0), 0);
  const time_s = legs.reduce((sum, leg) => sum + (leg.time_s || 0), 0);
  const exposure_m = legs.reduce((sum, leg) => sum + (leg.exposure_m || 0), 0);
  const low_coverage_m = legs.reduce((sum, leg) => sum + (leg.low_coverage_m || 0), 0);
  const green_ratio = distance_m
    ? legs.reduce((sum, leg) => sum + (leg.green_ratio || 0) * (leg.distance_m || 0), 0) / distance_m
    : 0;
  const first = legs[0];
  const summary = {
    feasible,
    loop: true,
    order,
    orderLabel: order.map(campusShort).join(" → "),
    reason: feasible ? undefined : (legs.find((leg) => !leg?.feasible)?.reason || "闭环中有不可飞航段"),
    distance_m,
    time_s,
    height_m: first?.height_m || 0,
    exposure_m,
    green_ratio,
    low_coverage_m,
    climb: first?.climb || [],
    cruise: path.map((point) => [point[0], point[1], first?.height_m || 0]),
    descent: legs[legs.length - 1]?.descent || [],
  };
  return { order, legs, path, summary };
}

// 高德 3D 镜头在地图中心的后方。后退距离随俯仰和缩放变化，用实测算过的像素表换算成米。
function lookAheadMeters(pitch, zoom, lat) {
  const table = [[35, 1098], [45, 888], [55, 764], [62, 709], [68, 671], [72, 655], [76, 639], [80, 639]];
  const angle = Math.min(80, Math.max(35, pitch));
  let px = table[table.length - 1][1];
  for (let i = 0; i < table.length - 1; i += 1) {
    const [p0, y0] = table[i];
    const [p1, y1] = table[i + 1];
    if (angle >= p0 && angle <= p1) {
      const t = (angle - p0) / (p1 - p0);
      px = y0 + (y1 - y0) * t;
      break;
    }
  }
  const resolution = (156543.03392 * Math.cos(lat * Math.PI / 180)) / (2 ** zoom);
  return px * resolution;
}

function shiftBy(point, heading, meters) {
  const rad = heading * Math.PI / 180;
  const lat = point[1] + (meters * Math.cos(rad)) / 110540;
  const lng = point[0] + (meters * Math.sin(rad)) / (111320 * Math.cos(point[1] * Math.PI / 180));
  return [lng, lat];
}

function fitPoints(map, AMap, points) {
  if (!map || !AMap || !points?.length) return;
  let minLng = 180;
  let maxLng = -180;
  let minLat = 90;
  let maxLat = -90;
  points.forEach((point) => {
    minLng = Math.min(minLng, point[0]);
    maxLng = Math.max(maxLng, point[0]);
    minLat = Math.min(minLat, point[1]);
    maxLat = Math.max(maxLat, point[1]);
  });
  const padLng = Math.max(0.04, (maxLng - minLng) * 0.2);
  const padLat = Math.max(0.04, (maxLat - minLat) * 0.2);
  map.setBounds(new AMap.Bounds(
    [minLng - padLng, minLat - padLat],
    [maxLng + padLng, maxLat + padLat],
  ));
}

function constraintLabel(nofly, pop, green, windOn, windCase) {
  const names = [
    nofly && "禁飞",
    pop && "人口",
    green && "绿地",
    windOn && { "01": "低风", "02": "中风", "03": "高风" }[windCase],
  ].filter(Boolean);
  return names.length ? names.join(" · ") : "未开启";
}

function layerLabel(satellite, buildings, nofly, pop, veg, heatMode) {
  const modeName = { heat: "热力", hex: "蜂窝" }[heatMode];
  const names = [
    satellite && "卫星",
    buildings && "建筑",
    nofly && "禁飞区",
    pop && "人口",
    veg && "植被",
    (pop || veg) && modeName,
  ].filter(Boolean);
  return names.length ? names.join(" · ") : "无图层";
}

const ALT = { left: 48, right: 306, top: 16, ground: 96 };
const SOC = { left: 48, right: 306, top: 14, bottom: 96 };

function altitudeY(meters, scaleMax = 210) {
  const span = ALT.ground - ALT.top;
  const scale = scaleMax > 0 ? scaleMax : 210;
  return ALT.top + (1 - Math.min(1, (meters || 0) / scale)) * span;
}

function profileDot(progress, height = 210, scaleMax = height) {
  const t = Math.max(0, Math.min(1, progress || 0));
  const cruiseY = altitudeY(height, scaleMax);
  const x = ALT.left + t * (ALT.right - ALT.left);
  let y = cruiseY;
  if (t < 0.2) y = ALT.ground - (t / 0.2) * (ALT.ground - cruiseY);
  else if (t > 0.8) y = cruiseY + ((t - 0.8) / 0.2) * (ALT.ground - cruiseY);
  return { x, y };
}

function heightProfilePoints(height = 210, scaleMax = height) {
  const cruiseY = altitudeY(height, scaleMax);
  const climbX = ALT.left + (ALT.right - ALT.left) * 0.2;
  const descentX = ALT.left + (ALT.right - ALT.left) * 0.8;
  return `${ALT.left},${ALT.ground} ${climbX},${cruiseY} ${descentX},${cruiseY} ${ALT.right},${ALT.ground}`;
}

function socY(value) {
  const soc = Math.max(0, Math.min(1, value));
  return SOC.bottom - soc * (SOC.bottom - SOC.top);
}

function socX(progress) {
  const t = Math.max(0, Math.min(1, progress || 0));
  return SOC.left + t * (SOC.right - SOC.left);
}

function chartPoints(samples) {
  if (!samples?.length) return "";
  return samples.map((sample) => `${socX(sample.p)},${socY(sample.soc)}`).join(" ");
}

function chartArea(samples) {
  if (!samples?.length) return "";
  const first = samples[0];
  const last = samples[samples.length - 1];
  return `${socX(first.p)},${SOC.bottom} ${chartPoints(samples)} ${socX(last.p)},${SOC.bottom}`;
}

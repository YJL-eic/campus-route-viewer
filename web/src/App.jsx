import { useEffect, useMemo, useRef, useState } from "react";
import AMapLoader from "@amap/amap-jsapi-loader";
import {
  createLocaView,
  setLayerMode,
  setRouteViewMode,
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
  const [origin, setOrigin] = useState("main");
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
          zIndex: 4,
          heightFactor: 1.6,
          opacity: 0.95,
        });
        map.add(buildingsRef.current);
      }
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
        pin.textContent = campus.name.replace("校区", "");
        pin.addEventListener("click", (event) => {
          event.stopPropagation();
          // 与示例一致：进入起降点 3D 详情页，不在主图上局部缩放。
          setPad(campus);
        });
        const marker = new AMap.Marker({
          position: [campus.lon, campus.lat],
          content: pin,
          offset: new AMap.Pixel(-28, -42),
          title: `${campus.name}终端空域（示意）`,
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

  useEffect(() => {
    const map = mapObj.current;
    const buildings = buildingsRef.current;
    if (!map || !buildings) return;
    if (showBuildings) map.add(buildings);
    else map.remove(buildings);
  }, [showBuildings, mapReady]);

  async function showFullRoute() {
    const map = mapObj.current;
    const AMap = window.AMap;
    if (!map || !AMap || !meta || origin === dest) return;
    setPad(null);
    setViewpoint("overview");
    stop();
    setPhase("idle");
    setProgress(0);
    setAltitude(0);
    setSpeed(0);
    setSoc(1);
    const bundle = await loadLoop(origin, dest, meta.campuses);
    loopRef.current = bundle;
    setFlightMode("loop");
    setRoute(bundle.summary);
    setRemainM(bundle.summary.feasible ? bundle.summary.distance_m : 0);
    flyingRef.current = false;
    if (!bundle.summary.feasible) {
      showLoopProfile(window.Loca, locaRef.current, null);
      showFlyingLine(window.Loca, locaRef.current, null);
      return;
    }
    profileRef.current = showLoopProfile(window.Loca, locaRef.current, bundle.legs, "overview");
    legPathRef.current = bundle.path;
    moveDrone(bundle.legs[0].climb[0], false);
    fitPoints(map, AMap, bundle.path);
    map.setPitch(58);
    map.setRotation(-22);
    if (map.getZoom() < 11) map.setZoom(11.2);
  }

  const samples = useMemo(
    () => (route?.feasible ? buildBatterySeries(route, aircraft) : []),
    [route, aircraft],
  );
  const socNow = phase === "idle" ? 1 : soc;
  const lowBattery = socNow < 0.2;

  async function loadLeg(from, to) {
    const file = `/data/routes/n${Number(nofly)}_p${Number(pop)}_g${Number(green)}_w${wind}_${from}_${to}.json`;
    const data = await fetch(file).then((response) => response.json());
    return data;
  }

  async function loadLoop(from, to, campuses) {
    const order = resolveLoopOrder(from, to, campuses);
    const legs = [];
    for (let index = 0; index < order.length - 1; index += 1) {
      legs.push(await loadLeg(order[index], order[index + 1]));
    }
    return assembleLoop(order, legs);
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
    const series = buildBatterySeries(data, aircraft);
    const tick = (now) => {
      const play = playback.current;
      if (!play || play.paused) return;
      const elapsed = play.elapsed + (now - play.started);
      if (elapsed <= flightMs) {
        const ratio = Math.min(1, elapsed / flightMs);
        const pose = track
          ? poseOnTrack(track, ratio)
          : {
            point: data.climb[0],
            heading: 0,
            phase: "climb",
          };
        const heading = play.heading == null
          ? pose.heading
          : lerpAngle(play.heading, pose.heading || play.heading, 0.18);
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
    profileRef.current = showLoopProfile(window.Loca, locaRef.current, bundle.legs, "overview");
    legPathRef.current = bundle.path;
    restoreOverview();
  }

  function pauseFlight() {
    const play = playback.current;
    if (!play) return;
    if (play.paused) {
      play.paused = false;
      play.started = performance.now();
      setPaused(false);
      timer.current = requestAnimationFrame(play.tick);
      return;
    }
    play.elapsed += performance.now() - play.started;
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
      profileRef.current = showLoopProfile(window.Loca, locaRef.current, bundle.legs, "overview");
      legPathRef.current = bundle.path;
      moveDrone(bundle.legs[0].climb[0], false);
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
    marker.show();
    marker.getContent().className = cockpit ? "drone-wrap cockpit" : "drone-wrap";
    marker.setOffset(cockpit ? new window.AMap.Pixel(-58, -58) : new window.AMap.Pixel(-36, -36));
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
      const cruiseMix = Math.max(0, Math.min(1, (raised - 0.55) / 0.45));
      const pitch = lerp(34 + 28 * raised, 68, cruiseMix);
      const zoom = lerp(18.2 - 0.6 * raised, 17.2, cruiseMix);
      const gap = lerp(70, 130, cruiseMix);
      target = {
        pitch,
        zoom,
        rotation: (360 - heading) % 360,
        lng: shiftBy(point, (heading + 180) % 360, gap)[0],
        lat: shiftBy(point, (heading + 180) % 360, gap)[1],
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
    const follow = cockpit ? 0.16 : 0.1;
    cam.pitch = lerp(cam.pitch, target.pitch, follow);
    cam.zoom = lerp(cam.zoom, target.zoom, follow);
    cam.rotation = lerpAngle(cam.rotation, target.rotation, follow);
    cam.lng = lerp(cam.lng, target.lng, follow);
    cam.lat = lerp(cam.lat, target.lat, follow);
    play.cam = cam;
    map.setStatus({ animateEnable: false });
    map.setZoom(cam.zoom);
    map.setPitch(cam.pitch);
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
      const bundle = loopRef.current || await loadLoop(origin, dest, meta.campuses);
      loopRef.current = bundle;
      setFlightMode("loop");
      if (!bundle.summary.feasible) {
        setRoute(bundle.summary);
        setPhase("blocked");
        return;
      }
      await playLoop(bundle);
      return;
    }
    const data = await loadLeg(origin, dest);
    playRoute(data);
  }

  useEffect(() => {
    if (!meta || !mapReady) return undefined;
    if (origin === dest) {
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
  const canStart = origin !== dest && !flying && !paused;
  const heightDot = profileDot(progress);

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
        <section className="top-card">
          <h2>航段</h2>
          <div className="inline">
            <label className="field">
              <span>起点</span>
              <select value={origin} onChange={(event) => setOrigin(event.target.value)}>
                {(meta?.campuses || []).map((campus) => (
                  <option key={`from-${campus.id}`} value={campus.id}>{campus.name.replace("校区", "")}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>终点</span>
              <select value={dest} onChange={(event) => setDest(event.target.value)}>
                {(meta?.campuses || []).map((campus) => (
                  <option key={`to-${campus.id}`} value={campus.id}>{campus.name.replace("校区", "")}</option>
                ))}
              </select>
            </label>
            {origin !== dest && (
              <div className="group">
                <button className={viewpoint === "overview" ? "active" : ""} onClick={() => setViewpoint("overview")}>俯视</button>
                <button className={viewpoint === "cockpit" ? "active" : ""} onClick={() => setViewpoint("cockpit")}>第一人称</button>
              </div>
            )}
          </div>
        </section>
        <section className="top-card">
          <h2>约束</h2>
          <div className="inline">
            <div className="menu">
              <button className="menu-trigger" onClick={() => setMenu(menu === "rule" ? "" : "rule")}>
                {constraintLabel(nofly, pop, green, windOn, windCase)}
              </button>
              {menu === "rule" && (
                <div className="menu-panel">
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
                  {!nofly && <p className="warn">禁飞已关闭，这条线只作对照。</p>}
                </div>
              )}
            </div>
            <div className="group">
              <button className={aircraft === "20kg" ? "active" : ""} onClick={() => setAircraft("20kg")}>20 kg</button>
              <button className={aircraft === "10kg" ? "active" : ""} onClick={() => setAircraft("10kg")}>10 kg</button>
            </div>
          </div>
        </section>
        <section className="top-card">
          <h2>图层</h2>
          <div className="menu">
            <button className="menu-trigger" onClick={() => setMenu(menu === "layer" ? "" : "layer")}>
              {layerLabel(showBuildings, showNofly, showPop, showVeg, heatMode)}
            </button>
            {menu === "layer" && (
              <div className="menu-panel">
                <div className="group">
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
        </section>
        <div className="flight-actions">
          <button
            className={`ghost${flightMode === "loop" ? " active" : ""}`}
            disabled={!mapReady || origin === dest}
            onClick={showFullRoute}
          >
            展示整条航路
          </button>
          <button className="play start" disabled={!canStart} onClick={playSelection}>
            {flying ? "飞行中" : (flightMode === "loop" ? "环飞闭环" : "开始飞行")}
          </button>
          <button className="ghost" disabled={!flying} onClick={pauseFlight}>{paused ? "继续" : "暂停"}</button>
          <button className="ghost" disabled={!flying} onClick={endFlight}>结束</button>
        </div>
      </header>
      <aside className="panel">
        <section className="card">
          <h2>{flightMode === "loop" || route?.loop ? "闭环" : "本段"}</h2>
          {origin === dest && <p className="note">起点和终点需要是不同校区。</p>}
          {origin !== dest && !route && <p className="note">正在读取这条航段。</p>}
          {route?.feasible === false && <p className="warn">{route.reason}</p>}
          {route?.feasible && (
            <>
              {route.loop && route.orderLabel && (
                <p className="note">方向：{route.orderLabel}</p>
              )}
              <dl className="metrics">
                <div><dt>航程</dt><dd>{(route.distance_m / 1000).toFixed(2)}<small> km</small></dd></div>
                <div><dt>飞行</dt><dd>{(route.time_s / 60).toFixed(1)}<small> 分</small></dd></div>
                <div><dt>高度</dt><dd>{route.height_m}<small> 米</small></dd></div>
                <div><dt>暴露</dt><dd>{(route.exposure_m / 1000).toFixed(2)}</dd></div>
                <div><dt>植被</dt><dd>{(route.green_ratio * 100).toFixed(0)}<small> %</small></dd></div>
                <div><dt>低覆盖</dt><dd>{(route.low_coverage_m / 1000).toFixed(1)}<small> km</small></dd></div>
              </dl>
            </>
          )}
        </section>
        <section className="card">
          <h2>高度剖面</h2>
          <svg className="chart" viewBox="0 0 320 132" role="img" aria-label="高度剖面">
            {route?.feasible && (
              <>
                <line x1="40" y1="20" x2="304" y2="20" stroke="#e8ecf3" />
                <line x1="40" y1="58" x2="304" y2="58" stroke="#e8ecf3" />
                <line x1="40" y1="96" x2="304" y2="96" stroke="#e8ecf3" />
                <text x="4" y="24" fontSize="10" fill="#6d7482">{route.height_m}</text>
                <text x="4" y="62" fontSize="10" fill="#6d7482">{Math.round(route.height_m / 2)}</text>
                <text x="8" y="100" fontSize="10" fill="#6d7482">0</text>
                <text x="2" y="128" fontSize="10" fill="#9aa3b2">米</text>
                <polyline
                  fill="none"
                  stroke="#1a5eff"
                  strokeWidth="2.5"
                  points={heightProfilePoints(route.height_m)}
                />
                <circle cx={heightDot.x} cy={heightDot.y} r="4" fill="#c25a26" />
                <text x={Math.min(268, heightDot.x + 8)} y={Math.max(18, heightDot.y - 6)} fontSize="11" fill="#c25a26">
                  {phase === "idle" ? route.height_m : altitude} 米
                </text>
                <text x="48" y="124" fontSize="10" fill="#6d7482">爬升</text>
                <text x="150" y="124" fontSize="10" fill="#6d7482">平飞 {(route.distance_m / 1000).toFixed(1)} km</text>
                <text x="268" y="124" fontSize="10" fill="#6d7482">降落</text>
              </>
            )}
          </svg>
        </section>
        <section className="card">
          <h2>电量</h2>
          <svg className="chart" viewBox="0 0 320 110" role="img" aria-label="电量曲线">
            <line x1="36" y1="18" x2="304" y2="18" stroke="#e8ecf3" />
            <line x1="36" y1="46" x2="304" y2="46" stroke="#e8ecf3" />
            <line x1="36" y1="74" x2="304" y2="74" stroke="#e0b4a4" strokeDasharray="4 4" />
            <text x="8" y="22" fontSize="10" fill="#6d7482">100</text>
            <text x="12" y="50" fontSize="10" fill="#6d7482">60</text>
            <text x="14" y="78" fontSize="10" fill="#7a2e16">20</text>
            <text x="8" y="104" fontSize="10" fill="#9aa3b2">%</text>
            <polyline fill="none" stroke="#0e7490" strokeWidth="2.5" points={chartPoints(samples)} />
            <circle
              cx={36 + progress * 268}
              cy={90 - Math.max(0, Math.min(1, socNow)) * 72}
              r="4"
              fill="#c25a26"
            />
            <text x="48" y="104" fontSize="10" fill="#6d7482">爬升耗电高</text>
            <text x="140" y="104" fontSize="10" fill="#6d7482">巡航平台区</text>
            <text x="240" y="104" fontSize="10" fill="#6d7482">末端陡降</text>
          </svg>
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
      </div>
      {pad && (
        <SiteDetail campus={pad} onBack={() => setPad(null)} />
      )}
    </div>
  );
}

/** 以「起点→终点」为第一段，第三人作为中转，构成三校区闭环。 */
function resolveLoopOrder(origin, dest, campuses = []) {
  const ids = (campuses || []).map((campus) => campus.id);
  const third = ids.find((id) => id !== origin && id !== dest) || ids[0];
  return [origin, dest, third, origin];
}

function campusShort(id) {
  return ({ main: "主", junshan: "军山", tongji: "同济" })[id] || id;
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

function layerLabel(buildings, nofly, pop, veg, heatMode) {
  const modeName = { heat: "热力", hex: "蜂窝" }[heatMode];
  const names = [
    buildings && "建筑",
    nofly && "禁飞区",
    pop && "人口",
    veg && "植被",
    (pop || veg) && modeName,
  ].filter(Boolean);
  return names.length ? names.join(" · ") : "无图层";
}

function profileDot(progress) {
  const clamped = Math.max(0, Math.min(1, progress || 0));
  const x = 40 + clamped * 264;
  let y = 20;
  if (clamped < 0.2) y = 96 - (clamped / 0.2) * 76;
  else if (clamped > 0.8) y = 20 + ((clamped - 0.8) / 0.2) * 76;
  return { x, y };
}

function heightProfilePoints() {
  return "40,96 93,20 251,20 304,96";
}

function chartPoints(samples) {
  if (!samples?.length) return "36,18 304,18";
  return samples.map((sample) => {
    const x = 36 + sample.p * 268;
    const y = 90 - Math.max(0, Math.min(1, sample.soc)) * 72;
    return `${x},${y}`;
  }).join(" ");
}

(function () {
  const cfg = window.APP_CONFIG || {};
  const COLORS = {
    northbound: "#c0392b", // 南→北 210 m（PPT 红）
    southbound: "#1a5276", // 北→南 160 m（PPT 蓝）
    main: "#c0392b",
    tongji: "#6c3483",
    junshan: "#1a5276",
    hub: "#d4a017",
  };

  // 终端空域规划采用值（丰舟90 · 终端空域平面与剖面）
  const TERMINAL = {
    hNorth: 210, // 南→北巡航中心
    hSouth: 160, // 北→南巡航中心
    bandHalf: 10, // ±10 m 保护带
    rInner: 25,
    hInner: 60,
    rOuter: 50,
    hOuter: 80,
  };

  let map = null;
  let loca = null;
  let airLayer = null;
  let terminalLayer = null;
  let markers = [];
  let currentMode = null;
  let data = { nodes: [], fast: null, safe: null, meta: null };

  function $(id) {
    return document.getElementById(id);
  }

  function needKey() {
    return !cfg.amapKey || cfg.amapKey.includes("请替换");
  }

  function showKeyBanner() {
    const el = $("keyBanner");
    if (el) el.classList.add("show");
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("脚本加载失败: " + src));
      document.head.appendChild(s);
    });
  }

  async function loadJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("加载失败: " + url);
    return res.json();
  }

  function clearLocaLayers() {
    if (!loca) return;
    [airLayer, terminalLayer].forEach((layer) => {
      if (!layer) return;
      try {
        loca.remove(layer);
        layer.destroy && layer.destroy();
      } catch (_) {
        /* ignore */
      }
    });
    airLayer = null;
    terminalLayer = null;
  }

  function clearRoutes() {
    clearLocaLayers();
    currentMode = null;
    document.querySelectorAll(".btn-mode").forEach((b) => b.classList.remove("active"));
    updateInfo(null);
  }

  function updateInfo(fc, modeLabel) {
    const box = $("routeInfo");
    if (!box) return;
    if (!fc || !fc.features || !fc.features.length) {
      box.innerHTML =
        '<div class="hint">尚未显示航路。点击「最快路线」或「安全路线」。每条走廊同时绘制南→北 210 m 与北→南 160 m 双层航道。</div>';
      return;
    }
    const rows = fc.features
      .map((f) => {
        const p = f.properties;
        return `<div class="info-row"><span>${p.label}${p.via_hub ? "（经中转）" : ""}</span>
          <span>${p.length_km} km · ${p.time_min} min</span></div>`;
      })
      .join("");
    box.innerHTML = `<h2>${modeLabel || "当前航路"} · 双层</h2>${rows}
      <div class="hint">红线 210 m（南→北），蓝线 160 m（北→南）；层差 50 m，保护带净距 30 m。机型：${
        (data.meta && data.meta.aircraft) || "丰舟90"
      }</div>`;
  }

  /**
   * 将每条规划几何展开为 PPT 中的双向双层航道：
   * - 同一水平走廊上下叠置（非横向平行）
   * - 红：210 m 南→北；蓝：160 m 北→南
   */
  function buildDualAirwayGeoJSON(fc) {
    const features = [];
    fc.features.forEach((f) => {
      const coords = (f.geometry.coordinates || []).map((c) => [c[0], c[1]]);
      if (coords.length < 2) return;
      const props = f.properties || {};
      const a = coords[0];
      const b = coords[coords.length - 1];
      const latIncreases = b[1] >= a[1];
      const northPath = latIncreases ? coords : coords.slice().reverse();
      const southPath = latIncreases ? coords.slice().reverse() : coords;

      features.push({
        type: "Feature",
        properties: {
          layer: "northbound",
          altitude: TERMINAL.hNorth,
          color: COLORS.northbound,
          label: props.label,
          direction: "南→北",
        },
        geometry: { type: "LineString", coordinates: northPath },
      });
      features.push({
        type: "Feature",
        properties: {
          layer: "southbound",
          altitude: TERMINAL.hSouth,
          color: COLORS.southbound,
          label: props.label,
          direction: "北→南",
        },
        geometry: { type: "LineString", coordinates: southPath },
      });
    });
    return { type: "FeatureCollection", features };
  }

  function buildTerminalPrismGeoJSON() {
    const features = [];
    data.nodes.forEach((n) => {
      features.push({
        type: "Feature",
        properties: {
          kind: "inner",
          radius: TERMINAL.rInner,
          altitude: TERMINAL.hInner,
          topColor: "rgba(212,160,23,0.55)",
          sideTop: "rgba(212,160,23,0.35)",
          sideBottom: "rgba(212,160,23,0.08)",
        },
        geometry: { type: "Point", coordinates: [n.lon, n.lat] },
      });
      features.push({
        type: "Feature",
        properties: {
          kind: "outer",
          radius: TERMINAL.rOuter,
          altitude: TERMINAL.hOuter,
          topColor: "rgba(26,82,118,0.25)",
          sideTop: "rgba(26,82,118,0.18)",
          sideBottom: "rgba(26,82,118,0.05)",
        },
        geometry: { type: "Point", coordinates: [n.lon, n.lat] },
      });
    });
    return { type: "FeatureCollection", features };
  }

  function drawElevatedAirways(fc) {
    if (!loca || typeof Loca === "undefined") {
      console.warn("Loca 不可用，无法绘制立体双层航道");
      return;
    }
    clearLocaLayers();

    const dual = buildDualAirwayGeoJSON(fc);
    const airSource = new Loca.GeoJSONSource({ data: dual });
    airLayer = new Loca.LineLayer({
      zIndex: 120,
      opacity: 1,
      visible: true,
    });
    airLayer.setSource(airSource);
    airLayer.setStyle({
      color: (_i, feat) => (feat && feat.properties && feat.properties.color) || COLORS.northbound,
      lineWidth: 5,
      altitude: (_i, feat) => {
        const p = feat && feat.properties;
        return (p && p.altitude) || TERMINAL.hNorth;
      },
      borderWidth: 0,
    });
    loca.add(airLayer);

    try {
      if (Loca.PrismLayer) {
        const stubFc = buildTerminalPrismGeoJSON();
        const stubSource = new Loca.GeoJSONSource({ data: stubFc });
        terminalLayer = new Loca.PrismLayer({
          zIndex: 110,
          opacity: 0.9,
          visible: true,
          hasSide: true,
        });
        terminalLayer.setSource(stubSource);
        terminalLayer.setStyle({
          unit: "meter",
          sideNumber: 24,
          radius: (_i, feat) => (feat && feat.properties && feat.properties.radius) || 25,
          height: (_i, feat) => (feat && feat.properties && feat.properties.altitude) || 60,
          topColor: (_i, feat) =>
            (feat && feat.properties && feat.properties.topColor) || "rgba(212,160,23,0.5)",
          sideTopColor: (_i, feat) =>
            (feat && feat.properties && feat.properties.sideTop) || "rgba(212,160,23,0.3)",
          sideBottomColor: (_i, feat) =>
            (feat && feat.properties && feat.properties.sideBottom) || "rgba(212,160,23,0.08)",
        });
        loca.add(terminalLayer);
      }
    } catch (e) {
      console.warn("终端柱体绘制跳过", e);
    }
  }

  function drawRoutes(fc, modeLabel, btnId) {
    clearRoutes();
    if (!fc || !fc.features) return;
    currentMode = modeLabel;
    const btn = $(btnId);
    if (btn) btn.classList.add("active");

    drawElevatedAirways(fc);

    const boundsPaths = fc.features.map((f) =>
      f.geometry.coordinates.map((c) => [c[0], c[1]])
    );
    if (boundsPaths.length) {
      const flat = boundsPaths.flat();
      map.setFitView(
        [new AMap.Polyline({ path: flat, strokeOpacity: 0 })],
        false,
        [80, 160, 80, 320]
      );
      map.setPitch(58);
      map.setRotation(-22);
    }
    const z = map.getZoom();
    if (z < 13) map.setZoom(13.2);
    updateInfo(fc, modeLabel);
  }

  function addNodeMarkers() {
    markers.forEach((m) => map.remove(m));
    markers = [];
    data.nodes.forEach((n) => {
      const color = COLORS[n.id] || "#fff";
      const isHub = n.id === "hub";
      const marker = new AMap.Marker({
        position: [n.lon, n.lat],
        title: n.name,
        offset: new AMap.Pixel(-10, -10),
        content: `<div style="
          width:18px;height:18px;border-radius:${isHub ? "3px" : "50%"};
          background:${color};border:2px solid #fff;
          box-shadow:0 2px 8px rgba(0,0,0,.35);cursor:pointer;"></div>`,
        extData: n,
      });
      marker.setMap(map);
      marker.on("click", () => {
        const q = new URLSearchParams({
          id: n.id,
          name: n.name,
          lon: String(n.lon),
          lat: String(n.lat),
        });
        window.location.href = `site.html?${q.toString()}`;
      });
      markers.push(marker);

      const text = new AMap.Text({
        text: n.name,
        position: [n.lon, n.lat],
        offset: new AMap.Pixel(14, -12),
        style: {
          "background-color": "rgba(255,255,255,0.92)",
          "border-radius": "6px",
          border: "1px solid rgba(20,40,60,0.12)",
          color: "#1c2b36",
          "font-size": "12px",
          padding: "3px 8px",
          "box-shadow": "0 2px 8px rgba(20,40,60,0.12)",
        },
      });
      text.setMap(map);
      markers.push(text);
    });
  }

  async function init() {
    if (needKey()) {
      showKeyBanner();
      return;
    }
    [data.nodes, data.fast, data.safe, data.meta] = await Promise.all([
      loadJSON("data/nodes.json"),
      loadJSON("data/routes_fast.json"),
      loadJSON("data/routes_safe.json"),
      loadJSON("data/meta.json"),
    ]);

    map = new AMap.Map("map", {
      viewMode: "3D",
      pitch: 50,
      rotation: -15,
      zoom: cfg.defaultZoom || 12.5,
      center: cfg.defaultCenter || [114.28, 30.48],
      mapStyle: "amap://styles/normal",
      features: ["bg", "road", "building", "point"],
      showBuildingBlock: true,
    });

    if (typeof Loca !== "undefined") {
      loca = new Loca.Container({ map });
    } else {
      console.warn("Loca 未加载，立体航道不可用");
    }

    try {
      const buildings = new AMap.Buildings({
        zIndex: 100,
        zooms: [14, 20],
        heightFactor: 1,
      });
      map.add(buildings);
    } catch (e) {
      console.warn("Buildings layer unavailable", e);
    }

    AMap.plugin(["AMap.ControlBar", "AMap.ToolBar"], () => {
      map.addControl(
        new AMap.ControlBar({
          position: { right: "16px", top: "90px" },
          showZoomBar: true,
          showControlButton: true,
        })
      );
      map.addControl(new AMap.ToolBar({ position: { right: "28px", top: "220px" } }));
    });

    addNodeMarkers();
    map.setFitView(markers.filter((m) => m instanceof AMap.Marker));
    map.setPitch(50);

    $("btnFast").addEventListener("click", () =>
      drawRoutes(data.fast, "最快路线", "btnFast")
    );
    $("btnSafe").addEventListener("click", () =>
      drawRoutes(data.safe, "安全路线", "btnSafe")
    );
    $("btnClear").addEventListener("click", clearRoutes);

    updateInfo(null);
  }

  window.addEventListener("DOMContentLoaded", () => {
    if (needKey()) {
      showKeyBanner();
      return;
    }
    if (cfg.amapSecurityCode) {
      window._AMapSecurityConfig = { securityJsCode: cfg.amapSecurityCode };
    }
    const key = encodeURIComponent(cfg.amapKey);
    loadScript(`https://webapi.amap.com/maps?v=2.0&key=${key}`)
      .then(() => loadScript(`https://webapi.amap.com/loca?v=2.0.0&key=${key}`))
      .then(() => init())
      .catch((e) => {
        console.error(e);
        alert("地图初始化失败，请检查 Key、网络与数据文件。\n" + (e && e.message ? e.message : e));
        showKeyBanner();
      });
  });
})();

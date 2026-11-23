(function () {
  const cfg = window.APP_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const site = {
    id: params.get("id") || "main",
    name: params.get("name") || "起降点",
    lon: parseFloat(params.get("lon") || "114.28"),
    lat: parseFloat(params.get("lat") || "30.48"),
  };

  function $(id) {
    return document.getElementById(id);
  }

  function needKey() {
    return !cfg.amapKey || cfg.amapKey.includes("请替换");
  }

  async function loadNodeExtra() {
    try {
      const nodes = await (await fetch("data/nodes.json")).json();
      return nodes.find((n) => n.id === site.id) || null;
    } catch {
      return null;
    }
  }

  async function init() {
    if (needKey()) {
      $("keyBanner").classList.add("show");
      return;
    }
    const extra = await loadNodeExtra();
    $("siteTitle").textContent = site.name;
    $("siteMeta").textContent = `${extra ? extra.role : "站点"} · 高德 3D 实景附近`;

    const map = new AMap.Map("map3d", {
      viewMode: "3D",
      pitch: 55,
      rotation: -15,
      zoom: 17,
      center: [site.lon, site.lat],
      mapStyle: "amap://styles/normal",
      features: ["bg", "road", "building", "point"],
      showBuildingBlock: true,
    });

    // 3D 楼块（高德建筑数据）
    try {
      const buildings = new AMap.Buildings({
        zIndex: 130,
        zooms: [15, 20],
        heightFactor: 2,
      });
      map.add(buildings);
    } catch (e) {
      console.warn("Buildings layer unavailable", e);
    }

    const marker = new AMap.Marker({
      position: [site.lon, site.lat],
      title: site.name,
    });
    marker.setMap(map);

    const circle = new AMap.Circle({
      center: [site.lon, site.lat],
      radius: 180,
      strokeColor: "#1f8a70",
      strokeWeight: 2,
      fillColor: "#1f8a70",
      fillOpacity: 0.12,
    });
    circle.setMap(map);

    // 设计图占位 / 后续替换
    const slot = $("designSlot");
    if (extra && extra.design_image) {
      slot.innerHTML = `<img class="design-img" src="${extra.design_image}" alt="起降点设计图" />`;
    } else {
      slot.innerHTML = `
        <div class="placeholder-art">
          <div>
            <strong>起降点设计图（占位）</strong>
            设计图尚未提供。后续将图片放入 web/assets/ 并在 data/nodes.json
            中填写对应站点的 design_image 字段即可显示。
          </div>
        </div>`;
    }

    $("btnBack").addEventListener("click", () => {
      window.location.href = "index.html";
    });
  }

  window.addEventListener("DOMContentLoaded", () => {
    if (needKey()) {
      $("keyBanner").classList.add("show");
      $("siteTitle").textContent = site.name;
      return;
    }
    if (cfg.amapSecurityCode) {
      window._AMapSecurityConfig = { securityJsCode: cfg.amapSecurityCode };
    }
    const s = document.createElement("script");
    s.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(cfg.amapKey)}`;
    s.onload = () => init().catch((e) => alert(e.message));
    document.head.appendChild(s);
  });
})();

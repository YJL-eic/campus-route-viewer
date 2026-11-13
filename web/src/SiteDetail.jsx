import { useEffect, useRef } from "react";

/**
 * 起降点详情：对齐示例 site.html —— 左侧高德 3D + 建筑楼块，右侧站点说明与设计图占位。
 */
export default function SiteDetail({ campus, onBack }) {
  const mapHost = useRef(null);
  const mapRef = useRef(null);

  useEffect(() => {
    const AMap = window.AMap;
    if (!AMap || !mapHost.current || !campus) return undefined;

    const map = new AMap.Map(mapHost.current, {
      viewMode: "3D",
      pitch: 55,
      rotation: -15,
      zoom: 17,
      center: [campus.lon, campus.lat],
      mapStyle: "amap://styles/normal",
      features: ["bg", "road", "building", "point"],
      showBuildingBlock: true,
      pitchEnable: true,
      rotateEnable: true,
    });
    mapRef.current = map;

    try {
      if (AMap.Buildings) {
        map.add(new AMap.Buildings({
          zIndex: 130,
          zooms: [15, 20],
          heightFactor: 2,
        }));
      }
    } catch {
      // Buildings optional.
    }

    map.add(new AMap.Marker({
      position: [campus.lon, campus.lat],
      title: campus.name,
    }));
    map.add(new AMap.Circle({
      center: [campus.lon, campus.lat],
      radius: 180,
      strokeColor: "#1f8a70",
      strokeWeight: 2,
      fillColor: "#1f8a70",
      fillOpacity: 0.12,
    }));

    return () => {
      map.destroy();
      mapRef.current = null;
    };
  }, [campus]);

  const title = `${campus.name.replace(/校区$/, "")}校区起降点`;

  return (
    <div className="detail-layout">
      <div className="detail-map-wrap">
        <div className="detail-map" ref={mapHost} />
        <button type="button" className="back-btn" onClick={onBack}>← 返回航路图</button>
      </div>
      <aside className="detail-panel">
        <h2>站点详情</h2>
        <h1 className="detail-title">{title}</h1>
        <p className="detail-meta">起降点 · 高德 3D 实景附近</p>
        <div className="info-row"><span>视图</span><span>高德三维 + 建筑楼块</span></div>
        <div className="info-row"><span>坐标</span><span>{campus.lon.toFixed(5)}, {campus.lat.toFixed(5)}</span></div>
        <div className="info-row"><span>设计图</span><span>待上传</span></div>
        <div className="placeholder-art">
          <div>
            <strong>起降点设计图（占位）</strong>
            左侧为高德 3D 地图（含周边建筑模型）。设计图尚未提供；后续可将图片放入
            {" "}
            <code>web/public/assets/</code>
            {" "}
            并在站点数据中填写
            {" "}
            <code>design_image</code>
            {" "}
            显示。
          </div>
        </div>
        <p className="detail-hint">
          终端空域示意仍保留在主航路图的 Loca 柱体层（R25×H60 / R50×H80）。本页侧重查看起降点周边城市三维环境。
        </p>
      </aside>
    </div>
  );
}

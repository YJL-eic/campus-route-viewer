"""Build every switch combination, the S0–S2 schedules, and the report figures."""

import json
import time
from copy import deepcopy

import numpy as np

from route_planner.config import CAMPUSES, DATA, LOOPS, OUT, PAIRS, WEB_DATA, WIND_CASES
from route_planner.export_web import write_layers, write_meta, write_routes
from route_planner.figures import save_bars, save_map
from route_planner.geo import cruise_height_m, true_bearing_deg, utm50n_to_wgs84
from route_planner.rasters import cell_xy, load_fields
from route_planner.router import build_network, fastest_ground_mps, search, wind_seconds
from route_planner.schedule import build_orders, fly_day


def _check_wind():
    seconds = wind_seconds(np.array([1000.0]), np.array([0.0]), np.array([0.0]), np.array([2.0]), airspeed=10)
    if abs(float(seconds[0]) - 1000 / 12) > 1e-6:
        raise RuntimeError("wind triangle check failed")
    blocked = wind_seconds(np.array([100.0]), np.array([0.0]), np.array([6.0]), np.array([0.0]), airspeed=5)
    if np.isfinite(blocked[0]):
        raise RuntimeError("crosswind should be infeasible")


def _measure(path, network, fields, lat, lon, wind, height, blocked):
    rows = network["rows"]
    cols = network["cols"]
    cells = [(int(rows[node]), int(cols[node])) for node in path]
    east, north = fields["winds"][wind][height]
    distance = 0.0
    seconds = 0.0
    exposure = 0.0
    green = 0.0
    low = 0.0
    lons = []
    lats = []
    for (r1, c1), (r2, c2) in zip(cells, cells[1:]):
        segment = 100.0 * np.hypot(r2 - r1, c2 - c1)
        bearing = _bearing(lat[r1, c1], lon[r1, c1], lat[r2, c2], lon[r2, c2])
        u = 0.5 * (east[r1, c1] + east[r2, c2])
        v = 0.5 * (north[r1, c1] + north[r2, c2])
        flown = wind_seconds(np.array([segment]), np.array([bearing]), np.array([u]), np.array([v]))
        distance += segment
        seconds += float(flown[0])
        exposure += segment * 0.5 * (float(fields["exposure"][r1, c1]) + float(fields["exposure"][r2, c2]))
        green += segment * 0.5 * (float(fields["green"][r1, c1]) + float(fields["green"][r2, c2]))
        if fields["low"][r1, c1] or fields["low"][r2, c2]:
            low += segment
        lons.append(float(lon[r1, c1]))
        lats.append(float(lat[r1, c1]))
    r_last, c_last = cells[-1]
    lons.append(float(lon[r_last, c_last]))
    lats.append(float(lat[r_last, c_last]))
    conflicts = sum(int(blocked[r, c] == 1) for r, c in cells)
    return {
        "feasible": True,
        "cells": cells,
        "distance_m": distance,
        "time_s": seconds,
        "height_m": height,
        "exposure_m": exposure,
        "green_ratio": green / distance if distance else 0,
        "low_coverage_m": low,
        "conflicts": conflicts,
        "lon": lons,
        "lat": lats,
    }


def _bearing(lat1, lon1, lat2, lon2):
    return float(true_bearing_deg(lat1, lon1, lat2, lon2))


def _loop_metrics(routes, nofly, pop, green, wind, loop_name):
    distance = time_s = exposure = low = 0.0
    green_acc = 0.0
    conflicts = 0
    for start, end in zip(LOOPS[loop_name], LOOPS[loop_name][1:]):
        route = routes[(nofly, pop, green, wind, start, end)]
        if not route["feasible"]:
            return None
        distance += route["distance_m"]
        time_s += route["time_s"]
        exposure += route["exposure_m"]
        green_acc += route["green_ratio"] * route["distance_m"]
        low += route["low_coverage_m"]
        conflicts += route["conflicts"]
    return {
        "distance_km": distance / 1000,
        "time_min": time_s / 60,
        "exposure_km": exposure / 1000,
        "green_ratio": green_acc / distance if distance else 0,
        "low_km": low / 1000,
        "conflicts": conflicts,
    }


def main():
    started = time.time()
    _check_wind()
    print("loading rasters", flush=True)
    fields = load_fields()
    xx, yy = cell_xy()
    lat, lon = utm50n_to_wgs84(xx, yy)
    vmax = fastest_ground_mps(fields["winds"])
    print(f"ground-speed bound {vmax:.1f} m/s", flush=True)
    networks = {}
    for nofly in (1, 0):
        if nofly:
            mask = fields["blocked"] == 0
        else:
            mask = fields["inside"]
        print(f"building network nofly={nofly}", flush=True)
        networks[nofly] = build_network(mask, fields["exposure"], fields["green"], fields["low"], lat, lon, fields["winds"])
        print(f"  nodes {networks[nofly]['count']}", flush=True)

    routes = {}
    jobs = []
    for nofly in (1, 0):
        for pop in (1, 0):
            for green in (1, 0):
                for wind in WIND_CASES:
                    for origin, dest in PAIRS:
                        jobs.append((nofly, pop, green, wind, origin, dest))

    def weights(pop, green):
        if pop in (0, 1) and green in (0, 1):
            return (1.0 if pop else 0.0, 0.5 if green else 0.0)
        if pop == 3:
            return (3.0, 0.5)
        return (1.0, 0.25 if green == 0 else 1.0)

    def solve_one(nofly, pop_weight, green_weight, wind, origin, dest):
        height = cruise_height_m(CAMPUSES[origin]["lat"], CAMPUSES[dest]["lat"])
        network = networks[nofly]
        path = search(
            network,
            CAMPUSES[origin]["row"],
            CAMPUSES[origin]["col"],
            CAMPUSES[dest]["row"],
            CAMPUSES[dest]["col"],
            wind,
            height,
            pop_weight,
            green_weight,
            vmax,
        )
        if path is None:
            return {"feasible": False, "reason": "该条件下没有可行航迹", "origin": origin, "dest": dest, "height_m": height}
        measured = _measure(path, network, fields, lat, lon, wind, height, fields["blocked"])
        measured["origin"] = origin
        measured["dest"] = dest
        return measured

    total = len(jobs)
    for number, (nofly, pop, green, wind, origin, dest) in enumerate(jobs, start=1):
        pop_weight, green_weight = weights(pop, green)
        routes[(nofly, pop, green, wind, origin, dest)] = solve_one(nofly, pop_weight, green_weight, wind, origin, dest)
        if number % 12 == 0 or number == total:
            print(f"routes {number}/{total}  {time.time() - started:.0f}s", flush=True)

    extra_specs = {(3, 1): (3.0, 0.5), (1, 25): (1.0, 0.25), (1, 100): (1.0, 1.0)}
    extra_routes = {}
    for (pop_code, green_code), (pop_weight, green_weight) in extra_specs.items():
        for origin, dest in PAIRS:
            extra_routes[(pop_code, green_code, origin, dest)] = solve_one(1, pop_weight, green_weight, "00", origin, dest)
    print("routing done", flush=True)

    web_routes = []
    for nofly in (1, 0):
        for pop in (1, 0):
            for green in (1, 0):
                for wind in WIND_CASES:
                    for origin, dest in PAIRS:
                        route = routes[(nofly, pop, green, wind, origin, dest)]
                        web_routes.append(
                            (
                                {"nofly": nofly, "pop": pop, "green": green, "wind": wind, "origin": origin, "dest": dest},
                                route,
                            )
                        )
    print("writing web data", flush=True)
    index = write_routes(web_routes)
    features = json.loads((DATA / "model_features.geojson").read_text(encoding="utf-8"))
    write_layers(fields, lat, lon, features)
    write_meta(index)

    default_routes = {
        (origin, dest): routes[(1, 1, 1, "00", origin, dest)]
        for origin, dest in PAIRS
    }
    schedules = []
    for scenario in ("S0", "S1", "S2"):
        orders = build_orders(scenario)
        for loop_name in LOOPS:
            for payload in ("20kg", "10kg"):
                result = fly_day(loop_name, payload, default_routes, deepcopy(orders))
                result["scenario"] = scenario
                schedules.append(result)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "schedules.json").write_text(json.dumps(schedules, ensure_ascii=False, indent=2), encoding="utf-8")
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    (WEB_DATA / "schedules.json").write_text(
        json.dumps(
            [
                {key: value for key, value in item.items() if key != "legs"}
                | {"legs": item["legs"][:8]}
                for item in schedules
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    figure_dir = OUT / "figures"
    figure_dir.mkdir(parents=True, exist_ok=True)
    save_map(fields["blocked"], routes, figure_dir / "闭环航迹.png")
    labels = ["无风", "低风", "中风", "高风"]
    wind_keys = ["00", "01", "02", "03"]
    distance_series = {}
    time_series = {}
    exposure_series = {}
    for loop_name, label in (("junshan_first", "经军山"), ("tongji_first", "经同济")):
        metrics = [_loop_metrics(routes, 1, 1, 1, wind, loop_name) for wind in wind_keys]
        distance_series[label] = [item["distance_km"] for item in metrics]
        time_series[label] = [item["time_min"] for item in metrics]
        exposure_series[label] = [item["exposure_km"] for item in metrics]
    save_bars("默认权重下四个风场的闭环航程", labels, distance_series, figure_dir / "风场航程.png", "千米")
    save_bars("默认权重下四个风场的飞行时间", labels, time_series, figure_dir / "风场时间.png", "分钟")
    save_bars("默认权重下四个风场的人口暴露", labels, exposure_series, figure_dir / "风场暴露.png", "千米·暴露")

    def calm_loop(pop, green, loop_name="junshan_first"):
        if (pop, green) in {(0, 0), (0, 1), (1, 0), (1, 1)}:
            return _loop_metrics(routes, 1, pop, green, "00", loop_name)
        built = {}
        for origin, dest in PAIRS:
            built[(1, pop, green, "00", origin, dest)] = extra_routes[(pop, green, origin, dest)]
        return _loop_metrics(built, 1, pop, green, "00", loop_name)

    pop_labels = ["人口关", "人口1", "人口3"]
    pop_values = [calm_loop(0, 1), calm_loop(1, 1), calm_loop(3, 1)]
    save_bars(
        "无风、绿地 0.5 时人口权重对经军山闭环的影响",
        pop_labels,
        {
            "航程 km": [item["distance_km"] for item in pop_values],
            "暴露": [item["exposure_km"] for item in pop_values],
        },
        figure_dir / "人口权衡.png",
        "",
    )
    green_labels = ["绿地关", "0.25", "0.5", "1"]
    green_values = [
        calm_loop(1, 0),
        calm_loop_extra(extra_routes, 1, 25),
        calm_loop(1, 1),
        calm_loop_extra(extra_routes, 1, 100),
    ]
    save_bars(
        "无风、人口 1 时绿地权重对经军山闭环的影响",
        green_labels,
        {
            "航程 km": [item["distance_km"] for item in green_values],
            "植被比例": [item["green_ratio"] * 100 for item in green_values],
        },
        figure_dir / "绿地权衡.png",
        "",
    )
    _write_tables(routes, schedules, fields)
    print(f"finished in {time.time() - started:.0f}s", flush=True)


def calm_loop_extra(extra_routes, pop, green, loop_name="junshan_first"):
    built = {}
    for origin, dest in PAIRS:
        route = extra_routes[(pop, green, origin, dest)]
        built[(1, pop, green, "00", origin, dest)] = route
    return _loop_metrics(built, 1, pop, green, "00", loop_name)


def _write_tables(routes, schedules, fields):
    lines = ["开关,航段,可行,航程km,时间min,暴露km,植被比例,低覆盖km,禁行格"]
    for key, route in routes.items():
        if key[3] != "00" and not (key[0] == 1 and key[1] == 1 and key[2] == 1):
            continue
        if route["feasible"]:
            lines.append(
                "{0},{1}-{2},1,{3:.2f},{4:.1f},{5:.2f},{6:.3f},{7:.2f},{8}".format(
                    "n{0}-p{1}-g{2}-w{3}".format(*key[:4]),
                    key[4],
                    key[5],
                    route["distance_m"] / 1000,
                    route["time_s"] / 60,
                    route["exposure_m"] / 1000,
                    route["green_ratio"],
                    route["low_coverage_m"] / 1000,
                    route["conflicts"],
                )
            )
        else:
            lines.append("n{0}-p{1}-g{2}-w{3},{4}-{5},0,,,,,,,".format(*key))
    (OUT / "航段指标.csv").write_text("\n".join(lines), encoding="utf-8")
    schedule_lines = ["情景,方向,载重,完成率,准时率,未服务,架次,航程km,平均全程min,最低电量"]
    for item in schedules:
        schedule_lines.append(
            "{scenario},{loop},{payload},{served}/{orders},{on_time_rate},{unserved},{flights},{distance_km},{mean_door_min},{min_soc}".format(**item)
        )
    (OUT / "班次指标.csv").write_text("\n".join(schedule_lines), encoding="utf-8")
    (OUT / "参数表.md").write_text(_parameters(fields), encoding="utf-8")
    (OUT / "局限说明.md").write_text(_limits(), encoding="utf-8")
    (OUT / "运行说明.md").write_text(_howto(), encoding="utf-8")


def _parameters(fields):
    return f"""# 参数表

| 参数 | 取值 | 性质 |
|---|---|---|
| 机型 | 丰舟 90，20 kg / 70 km 与 10 kg / 110 km | 产品页成对公开值 |
| 巡航速度 | 30 m/s，暂代真空速 | 产品页巡航速度 |
| 爬升、下降 | 3 m/s | 爬升为产品页最大爬升速度，下降为同样取值的模拟 |
| 一次起降等效航程 | 210 米为 4.20 km，160 米为 3.20 km | 垂直时间乘巡航速度 |
| 可用航程 | 公布航程的 80% | 课程备用系数 |
| 补能 | 三个校区均可，30 分钟恢复满可用航程 | 课程假设 |
| 人口权重 | 开 1，关 0；敏感性另算 3 | 课程权重 |
| 绿地权重 | 开 0.5，关 0；敏感性另算 0.25 和 1 | 课程权重 |
| 人口缺失代价 | 0.5 | 课程假设 |
| 人口标定 P95 | {fields['p95_log']:.4f} | 由高覆盖格子的 log(1+密度) 计算一次 |
| 中转站 | 不使用 | 小组决定 |
| 成本 | 50 元/架次 + 2 元/km | 模拟 |
| 地面对照 | 直线 × 1.4，30 km/h，两端各 10 分钟 | 模拟 |
"""


def _limits():
    return """# 局限说明

航迹使用 2021 年地表、2023 年人口和 2026 年 10 月模式风场。禁飞区是手绘范围，不是现行官方空域图。

电量按等效航程扣除，不是电池实测。垂直阶段按巡航功率折算，真实垂起通常更费电。风只改变航迹和飞行时间。

10 kg 到 20 kg 之间的航程是两个公布点的连线。成本、地面车速和军山 500 米人口追加都是模拟。学校医院不单列，通信默认可用，备降只发生在三个校区。没有地形坡度。起降场窗口是示意模型。
"""


def _howto():
    return """# 运行说明

在作业目录执行：

```bash
python3 -m route_planner.run_all
cd web
npm install
npm run dev
```

需要本机已安装 Node.js。地图密钥放在 `web/.env.local`，变量名为 `VITE_AMAP_KEY` 和 `VITE_AMAP_SECURITY`。不要把密钥写进仓库。高德域名白名单留空后，用浏览器打开开发页面。

`outputs` 里是航段表、班次表和对比图。`web/public/data` 是界面读取的航迹和图层。
"""


if __name__ == "__main__":
    main()

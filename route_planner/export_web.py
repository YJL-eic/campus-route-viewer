"""Export GCJ-02 routes, heat layers, and campus markers."""

import json

import numpy as np

from route_planner.config import CAMPUSES, RANGE_KM, USABLE_FACTOR, WEB_DATA
from route_planner.geo import wgs84_to_gcj02


def _gcj_point(lon, lat):
    glon, glat = wgs84_to_gcj02(lon, lat)
    return float(np.asarray(glon)), float(np.asarray(glat))


def _profile(lon, lat, height):
    steps = 8
    climb = []
    for index in range(steps + 1):
        climb.append((float(lon[0]), float(lat[0]), height * index / steps))
    cruise = [(float(x), float(y), float(height)) for x, y in zip(lon[1:], lat[1:])]
    descent = []
    for index in range(1, steps + 1):
        descent.append((float(lon[-1]), float(lat[-1]), height * (1 - index / steps)))
    return climb, cruise, descent


def _samples(height, cruise_m, cruise_s):
    """Dense UAV discharge samples: climb draws harder, mid-pack is flatter, end falls faster."""
    climb_m = 10.0 * height
    descent_m = 10.0 * height
    total = climb_m + cruise_m + descent_m
    power = {"climb": 2.15, "cruise": 1.0, "descent": 0.88}
    weight = power["climb"] * climb_m + power["cruise"] * cruise_m + power["descent"] * descent_m
    climb_share = 0.2
    descent_share = 0.2
    series = {}
    for name, published_km in RANGE_KM.items():
        usable = USABLE_FACTOR * published_km * 1000.0
        samples = []
        for index in range(49):
            fraction = index / 48.0
            if fraction <= climb_share:
                phase = "climb"
                powered = power["climb"] * climb_m * (fraction / climb_share)
            elif fraction <= 1.0 - descent_share:
                phase = "cruise"
                cruise_frac = (fraction - climb_share) / (1.0 - climb_share - descent_share)
                powered = power["climb"] * climb_m + power["cruise"] * cruise_m * cruise_frac
            else:
                phase = "descent"
                descent_frac = (fraction - (1.0 - descent_share)) / descent_share
                powered = (
                    power["climb"] * climb_m
                    + power["cruise"] * cruise_m
                    + power["descent"] * descent_m * descent_frac
                )
            used = (powered / weight) * total
            energy_soc = max(0.0, (usable - used) / usable)
            samples.append(
                {
                    "p": round(fraction, 4),
                    "phase": phase,
                    "soc": round(_lipo_remaining(energy_soc), 4),
                }
            )
        series[name] = samples
    return series


def _lipo_remaining(energy_soc):
    value = min(1.0, max(0.0, energy_soc))
    if value >= 0.25:
        t = (value - 0.25) / 0.75
        return 0.22 + 0.78 * (0.35 * t + 0.65 * (t ** 0.72))
    t = value / 0.25
    return 0.22 * (t ** 1.35)


def route_document(route):
    if not route["feasible"]:
        return {"feasible": False, "reason": route.get("reason", "不可行")}
    glon, glat = wgs84_to_gcj02(route["lon"], route["lat"])
    climb, cruise, descent = _profile(glon, glat, route["height_m"])
    return {
        "feasible": True,
        "origin": route["origin"],
        "dest": route["dest"],
        "height_m": route["height_m"],
        "distance_m": round(route["distance_m"], 1),
        "time_s": round(route["time_s"], 1),
        "exposure_m": round(route["exposure_m"], 1),
        "green_ratio": round(route["green_ratio"], 4),
        "low_coverage_m": round(route["low_coverage_m"], 1),
        "conflicts": route["conflicts"],
        "climb": [[x, y, z] for x, y, z in climb],
        "cruise": [[x, y, z] for x, y, z in cruise],
        "descent": [[x, y, z] for x, y, z in descent],
        "battery": _samples(route["height_m"], route["distance_m"], route["time_s"]),
    }


def write_routes(routes):
    folder = WEB_DATA / "routes"
    folder.mkdir(parents=True, exist_ok=True)
    index = []
    for key, route in routes:
        name = "n{nofly}_p{pop}_g{green}_w{wind}_{origin}_{dest}.json".format(**key)
        (folder / name).write_text(json.dumps(route_document(route), ensure_ascii=False), encoding="utf-8")
        index.append({**{k: (int(v) if isinstance(v, (np.integer, bool)) else v) for k, v in key.items()}, "file": f"routes/{name}", "feasible": route["feasible"]})
    return index


def write_layers(fields, lat, lon, features):
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    nofly = {"type": "FeatureCollection", "features": []}
    for feature in features["features"]:
        layer = feature["properties"].get("layer")
        if layer not in ("restriction", "building_obstacle"):
            continue
        nofly["features"].append(
            {
                "type": "Feature",
                "properties": {"name": feature["properties"].get("name", "禁飞区"), "layer": layer},
                "geometry": _convert_geometry(feature["geometry"]),
            }
        )
    (WEB_DATA / "nofly.geojson").write_text(json.dumps(nofly, ensure_ascii=False), encoding="utf-8")

    step = 5
    rows, cols = np.mgrid[0:lat.shape[0]:step, 0:lat.shape[1]:step]
    inside = fields["inside"][rows, cols]
    pop = fields["population"][rows, cols]
    keep = inside & (pop > 0)
    heat = _points(lon[rows, cols][keep], lat[rows, cols][keep], pop[keep], "w")
    (WEB_DATA / "population.geojson").write_text(json.dumps(heat), encoding="utf-8")
    green = fields["green"][rows, cols]
    keep_g = inside & (green > 0.2)
    veg = _points(lon[rows, cols][keep_g], lat[rows, cols][keep_g], green[keep_g], "w")
    (WEB_DATA / "vegetation.geojson").write_text(json.dumps(veg), encoding="utf-8")


def _points(lon, lat, weight, key):
    glon, glat = wgs84_to_gcj02(lon, lat)
    features = []
    for x, y, value in zip(np.asarray(glon).ravel(), np.asarray(glat).ravel(), np.asarray(weight).ravel()):
        features.append(
            {
                "type": "Feature",
                "properties": {key: round(float(value), 3)},
                "geometry": {"type": "Point", "coordinates": [round(float(x), 6), round(float(y), 6)]},
            }
        )
    return {"type": "FeatureCollection", "features": features}


def _convert_geometry(geometry):
    return {"type": geometry["type"], "coordinates": _convert_coords(geometry["coordinates"])}


def _convert_coords(value):
    if isinstance(value, list) and value and isinstance(value[0], (int, float)):
        lon, lat = _gcj_point(value[0], value[1])
        return [round(lon, 6), round(lat, 6)]
    return [_convert_coords(item) for item in value]


def write_meta(route_index):
    campuses = []
    for key, campus in CAMPUSES.items():
        lon, lat = _gcj_point(campus["lon"], campus["lat"])
        campuses.append({"id": key, "name": campus["name"], "lon": round(lon, 6), "lat": round(lat, 6)})
    meta = {
        "campuses": campuses,
        "routes": route_index,
        "defaults": {"nofly": 1, "pop": 1, "green": 1, "wind": "00"},
        "aircraft": [
            {"id": "20kg", "label": "20 kg / 70 km", "range_km": 70, "usable_km": 56},
            {"id": "10kg", "label": "10 kg / 110 km", "range_km": 110, "usable_km": 88},
        ],
        "loops": {
            "junshan_first": ["main", "junshan", "tongji", "main"],
            "tongji_first": ["main", "tongji", "junshan", "main"],
        },
        "recharge_min": 30,
        "warn_soc": 0.2,
    }
    (WEB_DATA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

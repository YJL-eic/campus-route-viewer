"""Directed 8-neighbor routing with an admissible time lower bound."""

import heapq
import math

import numpy as np

from route_planner.config import CELL, GREEN_ON, L0, POP_ON, T0, VA
from route_planner.geo import true_bearing_deg

OFFSETS = (
    (-1, -1),
    (-1, 0),
    (-1, 1),
    (0, -1),
    (0, 1),
    (1, -1),
    (1, 0),
    (1, 1),
)


def wind_seconds(distance, bearing_deg, east, north, airspeed=VA):
    angle = np.deg2rad(bearing_deg)
    along = east * np.sin(angle) + north * np.cos(angle)
    cross = east * np.cos(angle) - north * np.sin(angle)
    seconds = np.full(np.shape(east), np.inf, dtype=np.float64)
    room = np.abs(cross) < airspeed
    if not np.any(room):
        return seconds
    ground = np.sqrt(airspeed * airspeed - np.square(cross[room])) + along[room]
    usable = ground > 0
    target = seconds[room]
    target[usable] = np.asarray(distance, dtype=np.float64)[room][usable] / ground[usable]
    seconds[room] = target
    return seconds


def build_network(passable, exposure, green, low, lat, lon, winds):
    height, width = passable.shape
    rows, cols = np.nonzero(passable)
    count = int(rows.size)
    index = np.full((height, width), -1, dtype=np.int32)
    index[rows, cols] = np.arange(count, dtype=np.int32)
    src_parts = []
    dst_parts = []
    dist_parts = []
    bear_parts = []
    p_parts = []
    g_parts = []
    low_parts = []
    wind_parts = {code: {160: [], 210: []} for code in winds}

    for dr, dc in OFFSETS:
        row2 = rows + dr
        col2 = cols + dc
        inside = (row2 >= 0) & (row2 < height) & (col2 >= 0) & (col2 < width)
        if not np.any(inside):
            continue
        r1 = rows[inside]
        c1 = cols[inside]
        r2 = row2[inside]
        c2 = col2[inside]
        src = np.flatnonzero(inside).astype(np.int32)
        good = passable[r2, c2]
        if dr != 0 and dc != 0:
            good = good & passable[r2, c1] & passable[r1, c2]
        if not np.any(good):
            continue
        r1, c1, r2, c2, src = r1[good], c1[good], r2[good], c2[good], src[good]
        dst = index[r2, c2]
        keep = dst >= 0
        r1, c1, r2, c2, src, dst = r1[keep], c1[keep], r2[keep], c2[keep], src[keep], dst[keep]
        distance = np.full(src.shape, CELL * math.hypot(dr, dc), dtype=np.float64)
        bearing = true_bearing_deg(lat[r1, c1], lon[r1, c1], lat[r2, c2], lon[r2, c2])
        p_bar = 0.5 * (exposure[r1, c1] + exposure[r2, c2]).astype(np.float64)
        g_bar = 0.5 * (green[r1, c1] + green[r2, c2]).astype(np.float64)
        low_len = np.where(low[r1, c1] | low[r2, c2], distance, 0.0)
        src_parts.append(src)
        dst_parts.append(dst.astype(np.int32))
        dist_parts.append(distance)
        bear_parts.append(bearing)
        p_parts.append(p_bar)
        g_parts.append(g_bar)
        low_parts.append(low_len)
        for code, layers in winds.items():
            for level, (east, north) in layers.items():
                u = 0.5 * (east[r1, c1] + east[r2, c2])
                v = 0.5 * (north[r1, c1] + north[r2, c2])
                missing = (east[r1, c1] < -1e4) | (east[r2, c2] < -1e4) | (north[r1, c1] < -1e4) | (north[r2, c2] < -1e4)
                seconds = wind_seconds(distance, bearing, u, v)
                seconds[missing] = np.inf
                wind_parts[code][level].append(seconds.astype(np.float32))

    src = np.concatenate(src_parts)
    dst = np.concatenate(dst_parts)
    order = np.argsort(src, kind="mergesort")
    network = {
        "rows": rows.astype(np.int32),
        "cols": cols.astype(np.int32),
        "index": index,
        "src": src[order],
        "dst": dst[order],
        "dist": np.concatenate(dist_parts)[order].astype(np.float32),
        "bearing": np.concatenate(bear_parts)[order].astype(np.float32),
        "p_bar": np.concatenate(p_parts)[order].astype(np.float32),
        "g_bar": np.concatenate(g_parts)[order].astype(np.float32),
        "low": np.concatenate(low_parts)[order].astype(np.float32),
        "time": {},
    }
    for code in winds:
        network["time"][code] = {}
        for level in (160, 210):
            network["time"][code][level] = np.concatenate(wind_parts[code][level])[order]
    counts = np.bincount(network["src"], minlength=count)
    offset = np.zeros(count + 1, dtype=np.int32)
    offset[1:] = np.cumsum(counts)
    network["offset"] = offset
    network["count"] = count
    return network


def fastest_ground_mps(winds):
    peak = VA
    for layers in winds.values():
        for east, north in layers.values():
            speed = np.hypot(east, north)
            speed = speed[speed < 1e4]
            if speed.size:
                peak = max(peak, VA + float(speed.max()))
    return peak


def search(network, row1, col1, row2, col2, wind_code, height, pop_weight, green_weight, vmax):
    src = int(network["index"][row1, col1])
    dst = int(network["index"][row2, col2])
    if src < 0 or dst < 0:
        return None
    seconds = network["time"][wind_code][height]
    dist = network["dist"]
    cost = seconds / T0 + pop_weight * (dist / L0) * network["p_bar"] + green_weight * (dist / L0) * (1.0 - network["g_bar"])
    finite = np.isfinite(cost)
    src_e = network["src"][finite]
    dst_e = network["dst"][finite]
    cost = cost[finite].astype(np.float64)
    count = network["count"]
    counts = np.bincount(src_e, minlength=count)
    offset = np.zeros(count + 1, dtype=np.int32)
    offset[1:] = np.cumsum(counts, dtype=np.int32)
    order = np.argsort(src_e, kind="mergesort")
    to = dst_e[order]
    weight = cost[order]
    return _astar(offset, to, weight, src, dst, network["rows"], network["cols"], vmax)


def _astar(offset, to, weight, src, dst, rows, cols, vmax):
    count = offset.size - 1
    best = [1e100] * count
    pred = [-1] * count
    best[src] = 0.0
    scale = 1.0 / (vmax * T0)
    goal_r = int(rows[dst])
    goal_c = int(cols[dst])
    row_l = rows.tolist()
    col_l = cols.tolist()
    off = offset.tolist()
    nxt = to.tolist()
    cost = weight.tolist()
    push = heapq.heappush
    pop = heapq.heappop
    queue = [(scale * math.hypot((row_l[src] - goal_r) * CELL, (col_l[src] - goal_c) * CELL), 0.0, src)]
    while queue:
        _, spent, node = pop(queue)
        if spent != best[node]:
            continue
        if node == dst:
            break
        start = off[node]
        stop = off[node + 1]
        for edge in range(start, stop):
            nxt_node = nxt[edge]
            proposed = spent + cost[edge]
            if proposed < best[nxt_node]:
                best[nxt_node] = proposed
                pred[nxt_node] = node
                guess = proposed + scale * math.hypot((row_l[nxt_node] - goal_r) * CELL, (col_l[nxt_node] - goal_c) * CELL)
                push(queue, (guess, proposed, nxt_node))
    if best[dst] >= 1e90:
        return None
    path = []
    cursor = dst
    seen = set()
    while cursor != src:
        if cursor in seen or cursor < 0:
            return None
        seen.add(cursor)
        path.append(cursor)
        cursor = pred[cursor]
    path.append(src)
    path.reverse()
    return path


def default_weights(pop_on, green_on):
    return (POP_ON if pop_on else 0.0, GREEN_ON if green_on else 0.0)

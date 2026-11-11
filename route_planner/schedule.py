"""Flight schedules for the simulated campus orders."""

from route_planner.config import (
    HANDOFF_MIN,
    LOAD_MIN,
    LOOPS,
    RANGE_KM,
    RECHARGE_MIN,
    S0_COUNTS,
    SERVICE_END_MIN,
    USABLE_FACTOR,
)


def build_orders(scenario):
    if scenario == "S1":
        counts = {key: value * 2 for key, value in S0_COUNTS.items()}
        window = 120.0
    else:
        counts = dict(S0_COUNTS)
        window = 360.0
    orders = []
    number = 1
    for (origin, dest), count in counts.items():
        half = count // 2
        for index in range(1, count + 1):
            pickup = 8 * 60 + (index - 0.5) * window / count
            orders.append(
                {
                    "id": f"{scenario}-{number}",
                    "scenario": scenario,
                    "origin": origin,
                    "dest": dest,
                    "kg": 1 if index <= half else 2,
                    "pickup": pickup,
                    "deadline": pickup + 240,
                    "urgent": False,
                    "status": "waiting",
                }
            )
            number += 1
    if scenario == "S2":
        orders.append(
            {
                "id": f"{scenario}-{number}",
                "scenario": scenario,
                "origin": "main",
                "dest": "junshan",
                "kg": 1,
                "pickup": 9 * 60 + 30,
                "deadline": 9 * 60 + 30 + 90,
                "urgent": True,
                "status": "waiting",
            }
        )
        number += 1
        orders.append(
            {
                "id": f"{scenario}-{number}",
                "scenario": scenario,
                "origin": "junshan",
                "dest": "tongji",
                "kg": 1,
                "pickup": 14 * 60,
                "deadline": 14 * 60 + 90,
                "urgent": True,
                "status": "waiting",
            }
        )
    return orders


def _waiting(orders):
    return [order for order in orders if order["status"] == "waiting"]


def fly_day(loop_name, payload_key, routes, orders):
    usable_m = USABLE_FACTOR * RANGE_KM[payload_key] * 1000.0
    capacity = 20 if payload_key == "20kg" else 10
    cycle = LOOPS[loop_name][:-1]
    clock = 8 * 60
    index = 0
    location = cycle[0]
    aboard = []
    remain = usable_m
    flights = []
    arrived = False
    cycles = 0
    failed = None
    while cycles < 12 and clock < SERVICE_END_MIN:
        if arrived:
            landing = [order for order in aboard if order["dest"] == location]
            if landing:
                clock += LOAD_MIN
                for order in landing:
                    order["status"] = "done"
                    order["delivery"] = clock + HANDOFF_MIN
                aboard = [order for order in aboard if order["dest"] != location]
            clock += RECHARGE_MIN
            remain = usable_m
            arrived = False
        if clock >= SERVICE_END_MIN:
            break
        ready = [
            order
            for order in orders
            if order["status"] == "waiting" and order["origin"] == location and order["pickup"] <= clock + 1e-6
        ]
        if not ready and not aboard:
            pending = _waiting(orders)
            if not pending:
                break
            nxt_pickup = min(order["pickup"] for order in pending)
            if nxt_pickup > clock:
                clock = min(nxt_pickup, float(SERVICE_END_MIN))
            ready = [
                order
                for order in orders
                if order["status"] == "waiting" and order["origin"] == location and order["pickup"] <= clock + 1e-6
            ]
            if not ready and not any(order["origin"] != location for order in pending):
                break
        weight = sum(order["kg"] for order in aboard)
        loaded = False
        for order in sorted(ready, key=lambda item: (item["deadline"], item["id"])):
            if weight + order["kg"] <= capacity:
                order["status"] = "aboard"
                aboard.append(order)
                weight += order["kg"]
                loaded = True
        if loaded:
            clock += LOAD_MIN
        nxt_index = (index + 1) % len(cycle)
        nxt = cycle[nxt_index]
        route = routes.get((location, nxt))
        if route is None or not route["feasible"]:
            failed = "航段没有可行路径"
            break
        need = route["distance_m"] + 20.0 * route["height_m"]
        if need > remain + 1.0:
            failed = "补能后仍超过可用航程"
            break
        depart = clock
        clock += route["time_s"] / 60.0
        remain -= need
        flights.append(
            {
                "from": location,
                "to": nxt,
                "depart_min": round(depart, 2),
                "arrive_min": round(clock, 2),
                "distance_m": round(route["distance_m"], 1),
                "payload_kg": round(weight, 1),
                "soc_after": round(remain / usable_m, 4),
            }
        )
        location = nxt
        index = nxt_index
        arrived = True
        if index == 0:
            cycles += 1
            if not loaded and not any(order["status"] == "aboard" for order in orders) and not _waiting(orders):
                break
    done = [order for order in orders if order["status"] == "done"]
    on_time = [order for order in done if order["delivery"] <= order["deadline"] + 1e-6]
    durations = [order["delivery"] - order["pickup"] for order in done]
    return {
        "loop": loop_name,
        "payload": payload_key,
        "feasible_energy": failed is None,
        "note": failed,
        "cycles": cycles,
        "flights": len(flights),
        "distance_km": round(sum(item["distance_m"] for item in flights) / 1000.0, 2),
        "orders": len(orders),
        "served": len(done),
        "unserved": len(orders) - len(done),
        "on_time": len(on_time),
        "on_time_rate": round(len(on_time) / len(orders), 3) if orders else 0,
        "mean_door_min": round(sum(durations) / len(durations), 1) if durations else None,
        "min_soc": round(min((item["soc_after"] for item in flights), default=1), 4),
        "legs": flights,
    }

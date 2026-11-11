"""Directional wind-triangle timing for a fixed-airspeed course model.

Inputs are meteorological wind velocity components (east/north, m/s),
not FROM-direction angles. Bearing is clockwise from true north.
"""
import math


def track_ground_speed(airspeed_mps, bearing_deg, wind_east_mps, wind_north_mps):
    if airspeed_mps <= 0:
        raise ValueError('Airspeed must be positive')
    a=math.radians(bearing_deg)
    along=wind_east_mps*math.sin(a)+wind_north_mps*math.cos(a)
    cross=wind_east_mps*math.cos(a)-wind_north_mps*math.sin(a)
    if abs(cross) >= airspeed_mps:
        return None
    ground=math.sqrt(airspeed_mps**2-cross**2)+along
    return ground if ground>0 else None


def edge_seconds(distance_m, true_bearing_deg, airspeed_mps, u_east_mps, v_north_mps):
    if distance_m < 0:
        raise ValueError('Distance must be nonnegative')
    speed=track_ground_speed(airspeed_mps,true_bearing_deg,u_east_mps,v_north_mps)
    return math.inf if speed is None else distance_m/speed


def select_cruise_height(start_latitude, end_latitude):
    """Choose once per OD leg; do not change layers at every local turn."""
    if end_latitude>start_latitude:
        return 210
    if end_latitude<start_latitude:
        return 160
    raise ValueError('East-west OD: explicitly specify a cruise-height rule')


if __name__=='__main__':
    assert track_ground_speed(10,0,0,2)==12
    assert track_ground_speed(10,0,0,-2)==8
    assert abs(track_ground_speed(10,0,6,0)-8)<1e-12
    assert track_ground_speed(5,0,6,0) is None
    assert track_ground_speed(10,180,0,2)==8
    assert edge_seconds(1000,0,10,0,0)==100
    assert select_cruise_height(30.3,30.5)==210
    assert select_cruise_height(30.5,30.3)==160
    print('Directional wind-triangle checks passed.')

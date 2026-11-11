"""UTM zone 50N to WGS84, and WGS84 to GCJ-02."""

import math

import numpy as np


def utm50n_to_wgs84(easting, northing):
    """Inverse transverse Mercator for EPSG:32650. Returns lat, lon in degrees."""
    easting = np.asarray(easting, dtype=np.float64)
    northing = np.asarray(northing, dtype=np.float64)
    k0 = 0.9996
    a = 6378137.0
    ecc_sq = 0.00669438
    e1 = (1 - math.sqrt(1 - ecc_sq)) / (1 + math.sqrt(1 - ecc_sq))
    x = easting - 500000.0
    y = northing
    lon_origin = 117.0
    ecc_prime_sq = ecc_sq / (1 - ecc_sq)
    m = y / k0
    mu = m / (a * (1 - ecc_sq / 4 - 3 * ecc_sq**2 / 64 - 5 * ecc_sq**3 / 256))
    phi1 = (
        mu
        + (3 * e1 / 2 - 27 * e1**3 / 32) * np.sin(2 * mu)
        + (21 * e1**2 / 16 - 55 * e1**4 / 32) * np.sin(4 * mu)
        + (151 * e1**3 / 96) * np.sin(6 * mu)
        + (1097 * e1**4 / 512) * np.sin(8 * mu)
    )
    sin_phi = np.sin(phi1)
    cos_phi = np.cos(phi1)
    n1 = a / np.sqrt(1 - ecc_sq * sin_phi**2)
    t1 = np.tan(phi1) ** 2
    c1 = ecc_prime_sq * cos_phi**2
    r1 = a * (1 - ecc_sq) / ((1 - ecc_sq * sin_phi**2) ** 1.5)
    d = x / (n1 * k0)
    lat = phi1 - (n1 * np.tan(phi1) / r1) * (
        d**2 / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * ecc_prime_sq) * d**4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * ecc_prime_sq - 3 * c1**2) * d**6 / 720
    )
    lon = (
        d
        - (1 + 2 * t1 + c1) * d**3 / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * ecc_prime_sq + 24 * t1**2) * d**5 / 120
    ) / cos_phi
    return np.degrees(lat), lon_origin + np.degrees(lon)


def _delta_lat(x, y):
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * np.sqrt(np.abs(x))
    ret += (20.0 * np.sin(6.0 * x * np.pi) + 20.0 * np.sin(2.0 * x * np.pi)) * 2.0 / 3.0
    ret += (20.0 * np.sin(y * np.pi) + 40.0 * np.sin(y / 3.0 * np.pi)) * 2.0 / 3.0
    ret += (160.0 * np.sin(y / 12.0 * np.pi) + 320 * np.sin(y * np.pi / 30.0)) * 2.0 / 3.0
    return ret


def _delta_lon(x, y):
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * np.sqrt(np.abs(x))
    ret += (20.0 * np.sin(6.0 * x * np.pi) + 20.0 * np.sin(2.0 * x * np.pi)) * 2.0 / 3.0
    ret += (20.0 * np.sin(x * np.pi) + 40.0 * np.sin(x / 3.0 * np.pi)) * 2.0 / 3.0
    ret += (150.0 * np.sin(x / 12.0 * np.pi) + 300.0 * np.sin(x / 30.0 * np.pi)) * 2.0 / 3.0
    return ret


def wgs84_to_gcj02(lon, lat):
    lon = np.asarray(lon, dtype=np.float64)
    lat = np.asarray(lat, dtype=np.float64)
    a = 6378245.0
    ee = 0.00669342162296594323
    d_lat = _delta_lat(lon - 105.0, lat - 35.0)
    d_lon = _delta_lon(lon - 105.0, lat - 35.0)
    rad_lat = lat / 180.0 * np.pi
    magic = np.sin(rad_lat)
    magic = 1 - ee * magic * magic
    sqrt_magic = np.sqrt(magic)
    d_lat = (d_lat * 180.0) / ((a * (1 - ee)) / (magic * sqrt_magic) * np.pi)
    d_lon = (d_lon * 180.0) / (a / sqrt_magic * np.cos(rad_lat) * np.pi)
    return lon + d_lon, lat + d_lat


def true_bearing_deg(lat1, lon1, lat2, lon2):
    """Forward azimuth, degrees clockwise from true north."""
    phi1 = np.radians(lat1)
    phi2 = np.radians(lat2)
    dlon = np.radians(lon2 - lon1)
    y = np.sin(dlon) * np.cos(phi2)
    x = np.cos(phi1) * np.sin(phi2) - np.sin(phi1) * np.cos(phi2) * np.cos(dlon)
    return (np.degrees(np.arctan2(y, x)) + 360.0) % 360.0


def cruise_height_m(lat_start, lat_end):
    if lat_end > lat_start:
        return 210
    if lat_end < lat_start:
        return 160
    raise ValueError("east-west OD needs an explicit height rule")

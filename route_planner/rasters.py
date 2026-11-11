"""Load the aligned 100 m rasters with Pillow and build planning fields."""

from pathlib import Path

import numpy as np
from PIL import Image

from route_planner.config import CELL, DATA, NODATA, P_UNKNOWN

Image.MAX_IMAGE_PIXELS = None


def read_tif(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        return np.array(image)


def cell_xy():
    rows = 440
    cols = 521
    col = np.arange(cols, dtype=np.float64)
    row = np.arange(rows, dtype=np.float64)
    x = 205400.0 + (col + 0.5) * CELL
    y = 3392600.0 - (row + 0.5) * CELL
    xx, yy = np.meshgrid(x, y)
    return xx, yy


def load_fields():
    blocked = read_tif(DATA / "blocked_100m.tif")
    population = read_tif(DATA / "population_2023_100m.tif").astype(np.float64)
    pop_cov = read_tif(DATA / "population_valid_coverage_100m.tif").astype(np.float64)
    study = read_tif(DATA / "study_area_fraction_100m.tif").astype(np.float64)
    vegetation = read_tif(DATA / "vegetation_fraction_100m.tif").astype(np.float64)
    land_cov = read_tif(DATA / "landcover_valid_coverage_100m.tif").astype(np.float64)
    inside = blocked != 255

    def valid_float(array):
        return np.isfinite(array) & (array > -1e4)

    pop_ok = valid_float(population)
    cov_ok = valid_float(pop_cov)
    study_ok = valid_float(study)
    veg_ok = valid_float(vegetation)
    land_ok = valid_float(land_cov)

    area = np.where(study_ok, 10000.0 * np.clip(study, 0, 1), 0.0)
    coverage = np.where(cov_ok, np.clip(pop_cov, 0, 1), 0.0)
    rho = np.zeros(population.shape, dtype=np.float64)
    known = inside & pop_ok & (coverage > 0) & (area > 0)
    rho[known] = population[known] / (area[known] * coverage[known]) * 1_000_000.0
    log_rho = np.log1p(rho)
    sample = known & (coverage >= 0.95)
    if not np.any(sample):
        raise RuntimeError("no high-coverage population cells for P95")
    p95 = float(np.percentile(log_rho[sample], 95))
    if p95 <= 0:
        p95 = 1.0
    p_known = np.clip(log_rho / p95, 0, 1)
    exposure = np.full(population.shape, P_UNKNOWN, dtype=np.float64)
    exposure[known] = coverage[known] * p_known[known] + (1 - coverage[known]) * P_UNKNOWN
    exposure[~inside] = 0.0

    green = np.zeros(vegetation.shape, dtype=np.float64)
    green[veg_ok] = np.clip(vegetation[veg_ok], 0, 1)

    low = inside & (
        (~cov_ok)
        | (~land_ok)
        | (coverage < 0.95)
        | (np.where(land_ok, land_cov, 0) < 0.95)
    )

    winds = {}
    for code, folder in {
        "00": "case00_calm",
        "01": "case01_low",
        "02": "case02_median",
        "03": "case03_high",
    }.items():
        winds[code] = {}
        for height in (160, 210):
            u = read_tif(DATA / "风场" / folder / f"wind_u_east_{height}m.tif").astype(np.float64)
            v = read_tif(DATA / "风场" / folder / f"wind_v_north_{height}m.tif").astype(np.float64)
            winds[code][height] = (u, v)

    return {
        "blocked": blocked,
        "inside": inside,
        "exposure": exposure.astype(np.float32),
        "green": green.astype(np.float32),
        "low": low,
        "population": np.where(pop_ok, population, 0).astype(np.float32),
        "winds": winds,
        "p95_log": p95,
    }

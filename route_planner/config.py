"""Course parameters for the three-campus cargo routes."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "三校区100m空间数据交接包_绿地偏好_v5"
OUT = ROOT / "outputs"
WEB_DATA = ROOT / "web" / "public" / "data"

CELL = 100.0
VA = 30.0
CLIMB_MPS = 3.0
P_UNKNOWN = 0.5
POP_ON = 1.0
GREEN_ON = 0.5
T0 = 60.0
L0 = 1000.0
NODATA = -99999.0
RANGE_KM = {"20kg": 70.0, "10kg": 110.0}
USABLE_FACTOR = 0.8
WARN_SOC = 0.2
RECHARGE_MIN = 30.0
LOAD_MIN = 5.0
HANDOFF_MIN = 10.0
SERVICE_END_MIN = 18 * 60

CAMPUSES = {
    "main": {
        "name": "主校区",
        "row": 143,
        "col": 455,
        "lon": 114.4051558,
        "lat": 30.5110912,
        "x": 250984.09355555777,
        "y": 3378284.676662885,
    },
    "junshan": {
        "name": "军山校区",
        "row": 313,
        "col": 156,
        "lon": 114.0985099,
        "lat": 30.3508539,
        "x": 221088.86334819853,
        "y": 3361234.2048431803,
    },
    "tongji": {
        "name": "同济校区",
        "row": 59,
        "col": 313,
        "lon": 114.2544737,
        "lat": 30.5837045,
        "x": 236714.77412839403,
        "y": 3386678.5089836395,
    },
}

PAIRS = [
    ("main", "junshan"),
    ("junshan", "main"),
    ("main", "tongji"),
    ("tongji", "main"),
    ("junshan", "tongji"),
    ("tongji", "junshan"),
]

LOOPS = {
    "junshan_first": ["main", "junshan", "tongji", "main"],
    "tongji_first": ["main", "tongji", "junshan", "main"],
}

WIND_CASES = {
    "00": "case00_calm",
    "01": "case01_low",
    "02": "case02_median",
    "03": "case03_high",
}

# Base S0 directional order counts. Weights are 1 kg then 2 kg, split in half.
S0_COUNTS = {
    ("main", "junshan"): 6,
    ("junshan", "main"): 4,
    ("main", "tongji"): 4,
    ("tongji", "main"): 4,
    ("junshan", "tongji"): 4,
    ("tongji", "junshan"): 2,
}

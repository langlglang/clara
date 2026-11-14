# Admin app and kit placement planner

`/admin` (computer, 1440 px, Field Kit theme) has two tabs:

- **Network health**: pick an area (Houston downtown, Los Angeles downtown, the fictional Kestrel Valley Camp) to see every box on a Leaflet map with status (ready / low stock / in use / offline), battery, last seen, supply counts and open incidents, plus a summary panel.
- **Kit planner**: pick a CoStar building (default Wells Fargo Plaza, PropertyId 233899) and plan where Clara kits go so everyone is within 90 s walking of one. "Deploy kits" turns the committed plan into Clara boxes (with written directions) on the network, so they show on the admin map, the kit map and the consoles.

## Data

| Source | Used for |
|---|---|
| CoStar extract (`COSTAR_DATA_DIR`, local only) | building list (Matterport capture list), stories, floor sizes, people per floor = current tenants' `numEmployees` split by the area they occupy per floor (`floorName` is CoStar's FloorName enum: 24 = 1st floor, n ≥ 27 → level n − 24) |
| Matterport Model API (`MP_API_KEY`, `MP_API_TOKEN`) | whole-floor scans → walking graph from scan (pano) positions; level from the scan name ("Level 53", "Suite 3700" → 37) |
| Matterport Showcase SDK (`MP_SDK_KEY`, browser-safe) | the 3D tour of the selected floor, with "Clara kit" tags at planned kits when the SDK connects |
| Vexcel (`VEXCEL_API_KEY`) | parcel + building footprint, aerial image, street-facing walls → driver pickup points |

Everything fetched or derived is cached under `.placement-cache/` (gitignored). Never commit the CoStar extract or anything derived from it.

## Planner

`packages/placement`: data clients (injected fetch), walking graph and coverage (1.2 m/s, target 90 s), greedy placement on scanned floors, a core rule for unscanned floors (own kit at ≥ 150 people, else one per 3 floors on the middle one, 20 s per floor by stairs), pickup points, and a tool layer: `get_building`, `people_by_floor`, `get_floor_graph`, `get_aerial`, `evaluate_coverage`, `propose_kits`, `set_pickup_points`, `commit_plan`. With `ANTHROPIC_API_KEY` a deepagents deep agent (model `CLARA_PLANNER_MODEL`, else `CLARA_COORDINATOR_MODEL`, else claude-opus-5-5) plans, evaluates, revises and commits through those tools only; without it (or `CLARA_PLANNER=rules`, or on failure) a deterministic sequence drives the same tools. Every plan lists its assumptions.

## Without the CoStar extract (Render)

The planner says "CoStar extract not available on this server", offers only Wells Fargo Plaza from built-in public facts (name, address, 71 stories, scan ids) with no people data, and still uses Matterport and Vexcel when their keys are set.

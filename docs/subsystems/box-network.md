# Box network handoff — proposed demo

**Status:** proposed; nothing is implemented. Clara will never be used on a patient. The network links the team's own demo boxes. It does not contact emergency services, notify the public, or claim that a person is coming.

## What it does

Every Clara box reports its status to a small **box registry** in the cloud. A **network map** web page shows each box on a floor plan or map, and the boxes use the registry to help each other:

1. **Status on the map.** Each box is `ready`, `in_use`, `low_supplies`, or `offline`. A box that has missed its heartbeat is shown as `offline` with the time it was last seen, never as `ready`.
2. **Nearby boxes join in.** When Box A's Mock SOS opens, the backend sends a `network.alert` to the other boxes at the same site. Box B chimes, flashes its compartment lights, and shows a full-screen card: *"Emergency at Room 101 (Box A). Bring this kit."* with pre-written directions from its verified site record. Someone at Box B can tap **Bringing this kit**. Box A then shows *"Someone at Box B tapped 'Bringing this kit' at 20:01"*, labeled unconfirmed. It never says help has arrived.
3. **Nearest other kit.** If an item is missing or the volunteer says there are more injured people, the box can show the nearest other available box: *"Another kit is 40 m away, 2nd floor by the elevator."* This uses the directory's verified location and directions plus the box's current status and how old that status is.
4. **Live incident picture.** Opened boxes pulse on the network map, so a building manager or the demo audience sees where kits are in use.

For HackPrinceton, Box B can be a **mock box**: a laptop or tablet running the same box screen in a browser, optionally with a few LEDs on a second ESP32. It is configured as a second demo box at a fictional site location.

## Rules

- **Trigger.** Only an opened Mock SOS (`emergency.status: mock_opened`) at Box A sends a network alert. Pi or backend code sends it deterministically. The agent cannot send one, and a camera frame or sensor value never triggers one.
- **Never in the way.** Box A never waits for the network. If the cloud is down, Box A keeps its local guide and Mock SOS and shows *"Nearby boxes not notified (offline)."* A failed or late alert never turns into "sent."
- **Minimal content.** An alert carries the site, the originating box, its location and directions, a coarse need category (for example `bleeding_kit`), and the time. It contains no transcript, image, sensor value, or handoff card.
- **One alert per incident.** Duplicate SOS taps keep one `incident_id`. Box A closing, a Stop, or a staff clear ends the incident. Each receiving box clears its card and lights when the incident ends or after a short expiry (proposed: 10 minutes).
- **Interrupting a box in use.** If Box B already has an active session, the alert appears as a small banner. It does not take over Box B's guide or Mock SOS.
- **Directions are content, not model output.** Directions between boxes are written into the site record and checked by a teammate. The agent can read them aloud but cannot invent a route.
- **Status age.** The map and the nearest-kit card show when each status was last updated. A `low_supplies` flag comes from the verified manifest or a restock check, not from a guess.

## Pieces to build

| Piece | Owner | Notes |
| --- | --- | --- |
| Box heartbeat (`box.status`) | Pi | Every 30 s and on every state change. Includes manifest-based supply summary, never health data. |
| Box registry | Backend | Stores each box's site, verified location and directions, last status, and last-seen time. Marks a box `offline` after 3 missed heartbeats. |
| Alert fan-out | Backend | On `mock_opened`, sends `network.alert` to the other boxes at the same site. Records delivery and acknowledgment separately. |
| Receiving-box screen | Pi / touchscreen | Alert card, chime, light pattern, **Bringing this kit** button, banner mode when busy. |
| Nearest-kit lookup | Backend + agent tool `network.nearest_box` | Read-only. Returns the closest box whose status is fresh and `ready` or `low_supplies` (with a note). |
| Network map | Web page | Floor plan or map, status colors, pulsing in-use boxes, last-seen times. Read-only in the demo. |

Messages are defined in [contracts](../contracts.md). Behavior and failure handling are in [architecture](../architecture.md).

## Acceptance

Box A's Mock SOS works with the network unplugged. Box B shows the alert within a few seconds when connected. A duplicate SOS tap creates no second alert. A busy Box B gets a banner, not a takeover. Ending the incident clears Box B. A box with a stale heartbeat shows `offline` on the map and is never suggested as the nearest kit. Box A never claims that a person is coming.

## Later concept

Building-wide or campus-wide networks, alerts to security staff, and dispatch-console views would each need site-owner approval, access control, and privacy review. They are outside the demo.

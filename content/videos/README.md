# Step clips

Short, silent clips that loop on the box screen while a scenario step is shown (a step's `video` field). The spoken
words stay the step's own checked text; a clip only shows it. If a clip can't play, the box shows the step's `image`.

| Clip | Step | What it shows | Source |
| --- | --- | --- | --- |
| `cpr-hand-position-v1.webm` | `not_breathing` / `hand_position` | Side view: person on their back on a firm surface; the rescuer kneels with arms straight and shoulders over the hands; heel of one hand on the center of the chest, the other hand on top; pushes at 110 per minute with full recoil. Inset: hands on the lower half of the breastbone, seen from above. No words, so it works in every language. | Original project animation, drawn and recorded in a browser from `cpr-hand-position-v1.source.html` (640x360, VP9, 8 compressions, about 4.4 s). Still frame: `../visuals/cpr-hand-position-v1.png`. |

**DRAFT**: like the scenario, this clip needs a teammate's check against the AHA guidance linked in the scenario
before real use. To replace it with filmed footage, keep the file name (or update the step's `video`): short (3 to 8 s),
silent, 640x360 or 854x480, WebM (VP9) or MP4 (H.264), and showing exactly what the step text says.

To re-record the animation: serve `cpr-hand-position-v1.source.html` from localhost, open it in Chrome, and run
`await record(8)` in the console; the WebM is in `window.clip` (base64).

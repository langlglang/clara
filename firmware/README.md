# Clara ESP32 firmware

Adapted from [Sophi](https://github.com/mzhao1599/sophi) firmware layout and serial pattern. Pure logic lives in `lib/clara/`, hardware code in `src/main.cpp`, and native tests in `test/test_logic/`.

**Status:** `clara-0.2.0` builds and is flashed on the connected ESP32. The Pi adapter has received its hello and lid state, ACKs for all three LED channels and clear, and a fresh raw MAX30102 result. With no finger present, the pulse stream correctly reports null BPM. The native signal tests pass; a sustained on-finger pulse estimate and the installed lid mechanism remain unverified. Clara is a fictional-scenario demo, never used on a patient.

## Current board profile

The Pi stays powered and uses one USB data cable to the ESP32 board's USB-to-UART bridge. The Pi owns the screen, audio, cloud, kit manifest and decisions. The ESP32 debounces the switch, drives the three installed lights and reads the connected MAX30102. No Wi-Fi, camera, GPS or medical decision runs on the ESP32.

| ESP32 pin | Current connection | Status |
| --- | --- | --- |
| GPIO33 | Lid limit switch `NC`; `COM` to ground, internal pull-up. Released switch reads LOW = open. | Bench GPIO logic observed; installed lid mechanism still needs a close/open check. |
| GPIO21 / GPIO22 | MAX30102 SDA / SCL at 3.3 V logic, 100 kHz I²C | Bench raw samples verified. |
| GPIO18 / GPIO19 / GPIO23 | LED channels 0 / 1 / 2, each through its own resistor to ground | User observed all three blink in expected bench positions. |

`CLARA_LED_COUNT=3`, `CLARA_MOUNT_SWITCH=0`, and `CLARA_BUZZER_ENABLED=0` are set in `platformio.ini`. Other proposed LEDs, wall-mount switch and buzzer are **not wired or claimed working**. The proposed six-slot kit map must be verified separately before a supply can trigger a light. This firmware refuses light and pulse-start commands while the lid reads closed. A clear/off command always works. The switch orientation follows the tested bench wiring; confirm the actual lid's pressed/released states before using that gate.

## Build and flash

```sh
cd firmware
../.venv/bin/pio test -e native
../.venv/bin/pio run -e esp32
../.venv/bin/pio run -e esp32 -t upload --upload-port /dev/cu.SLAB_USBtoUART
```

Install PlatformIO in a local Python environment if needed (`python3 -m venv .venv && .venv/bin/pip install platformio` from the repo root). Close the old bench dashboard and any serial monitor before uploading; only one program can hold the port. On the Pi, use the board's `/dev/serial/by-id/` path or set `CLARA_SERIAL_PORT`. Run `npx tsx box/src/check/index.ts --port PATH --leds --lid` to check the physical link. The `--beep` option will fail in this profile because no buzzer is installed.

## USB serial contract `1.1`

The [shared schema](../packages/contracts/src/serial.ts) is the Pi's parser and command validator. Each message is one JSON line, at most 1,024 bytes, at 115200 baud. `hello` includes `proto:"1.1"`; the Pi rejects an older hello. Commands have an integer `id`; the ESP32 replies with `ack` for accepted or rejected commands. A Pi ping every three seconds asks for `hello` and current lid state. `seq` counts board state and sensor events from each boot; `boot` changes on reset.

| Pi command | ESP32 response and behavior |
| --- | --- |
| `{"t":"ping","id":1}` | ACK, then `hello`, `lid` (and `mount` only if enabled). |
| `{"t":"led","id":2,"ch":0,"ms":800,"mode":"blink"}` | ACK; channel 0 is GPIO18. One channel at a time; lease capped at 30 seconds. `ch:-1` clears. |
| `{"t":"sensor.read","id":3}` | ACK, then one `sensor.raw` with the same `id`, a new hardware sample after the command, or null values with `quality:"unavailable"` after one second. Missing sensor and closed lid are NACKs. |
| `{"t":"pulse.start","id":4}` / `pulse.stop` | ACK; streams one `pulse` event per second while started. BPM is null unless contact, sample continuity and recent beat intervals pass the algorithm's checks. |

Example raw **format only**, not an actual reading: `{"t":"sensor.raw","id":3,"seq":10,"sample_seq":81,"sampled_uptime_ms":30012,"red":40217,"ir":48701,"quality":"valid"}`. `valid` means a fresh, well-formed raw sample, **not a medically accurate vital sign**. A failed read is null, never a canned number. The Pi's `SerialBoard.readSensorRaw()` correlates the result to its request and returns null on timeout, disconnect, unavailable quality or malformed data. Do not log raw health readings in ordinary logs.

## Pulse estimate

The MAX30102 is configured for 100 conversions per second with four-sample FIFO averaging, so it delivers **25 records per second**. Firmware drains the FIFO and reconstructs 40 ms record spacing. An overrun or gap resets the estimate. The estimator uses the full 18-bit IR reading, removes slow baseline drift, smooths three records, finds peaks with a minimum prominence, and takes the median of recent beat intervals. It reports a number only after at least four consistent intervals in the 30–200 bpm range, with recent samples, contact above the configured threshold and no ADC saturation. Flat, missing, clipped, interrupted and irregular signals yield null BPM. The threshold and algorithm are engineering choices for this demo; compare a sustained real waveform against an independent reference before showing BPM as demo verified. **No SpO₂ is calculated.**

This approach uses the MAX30102's documented FIFO and sample averaging and the beat-interval principle described by [Analog Devices](https://support.analog.com/en-US/knowledgebase/article/000101121). [SparkFun's example](https://github.com/sparkfun/SparkFun_MAX3010x_Sensor_Library/blob/master/examples/Example5_HeartRate/Example5_HeartRate.ino) informs the contact threshold but explicitly does not establish medical accuracy. See [MAX30102 datasheet](https://www.analog.com/media/en/technical-documentation/data-sheets/MAX30102.pdf). The firmware's native tests use synthetic waveforms to check rejection and timing; they do not validate accuracy on people.

## Failure behavior

LEDs start off, only one compartment channel can be selected, and a lease expires even if the Pi disappears. Lid close clears lights and pulse streaming. Ten seconds without Pi serial traffic clears active lights, rhythm and buzzer state; the Pi reconnects and pings after USB loss. The sensor is probed every two seconds, so a reconnected breakout can recover; a missing sensor never yields a made-up reading. A read interrupted by lid close or sensor loss returns unavailable. An unwired buzzer command is rejected as unsupported. The ESP32 never claims an emergency call happened.

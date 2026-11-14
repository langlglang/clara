# Clara ESP32 firmware

Adapted from [Sophi](https://github.com/mzhao1599/sophi) firmware layout and serial pattern. Pure logic lives in `lib/clara/`, hardware code in `src/main.cpp`, and native tests in `test/test_logic/`.

**Status:** `clara-0.2.2` is flashed on the ESP32. The Pi adapter receives its hello, lid state, three LED ACKs and fresh MAX30102 samples. The installed LEDs were visually verified. A 23-second on-finger check on 2026-11-14 returned 18 valid pulse reports between 71 and 83 BPM; a seven-second uncovered check returned seven `unavailable` reports and no BPM. This verifies the hardware path and estimator output, not accuracy against a separate reference or Clara's spoken request flow. Clara is a fictional-scenario demo, never used on a patient.

## Current board profile

The Pi stays powered and uses one USB data cable to the ESP32 board's USB-to-UART bridge. The Pi owns the screen, audio, cloud, kit manifest and decisions. The ESP32 debounces the switch, drives the three installed lights and reads the connected MAX30102. No Wi-Fi, camera, GPS or medical decision runs on the ESP32.

| ESP32 pin | Current connection | Status |
| --- | --- | --- |
| GPIO33 | Lid limit switch `NC`; `COM` to ground, internal pull-up. Released switch reads LOW = open. | Bench GPIO logic observed; installed lid mechanism still needs a close/open check. |
| GPIO21 / GPIO22 | MAX30102 SDA / SCL at 3.3 V logic, 100 kHz I²C | Bench raw samples verified. |
| GPIO18 / GPIO19 / GPIO23 | LED channels 0 / 1 / 2, each through its own resistor to ground | User verified top-left small / top-right medium / bottom large slots with the integrated firmware. |

`CLARA_LED_COUNT=3`, `CLARA_MOUNT_SWITCH=0`, and `CLARA_BUZZER_ENABLED=0` are set in `platformio.ini`. Other proposed LEDs, wall-mount switch and buzzer are **not wired or claimed working**. The physical channel-to-position map is verified; the item-to-slot inventory still needs confirmation before retrieval instructions can claim a supply is in a slot. This firmware refuses light and pulse-start commands while the lid reads closed. A clear/off command always works.

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

The MAX30102 is configured for 100 conversions per second with four-sample FIFO averaging, so it delivers **25 records per second**. Firmware drains the FIFO and reconstructs 40 ms record spacing. An overrun or gap resets the estimate. The estimator uses the full 18-bit IR reading, removes slow baseline drift, smooths three records, detects the downward IR troughs observed on this reflective breakout, and takes the median of recent beat intervals. Version 0.2.2 lowered the prominence gate to 0.1% of the IR baseline (with an 80-count floor) after a live hold returned signal but no accepted beats. It still reports a number only after four of the five recent intervals agree within 18%, including the newest, in the 30–200 bpm range, with fresh samples, contact above the configured threshold and no ADC saturation. One isolated motion peak may be ignored; flat, missing, clipped, interrupted and persistently irregular signals yield null BPM. The post-flash hold yielded the valid reports above; the uncovered check yielded none. Accuracy against a separate pulse reference remains unverified. **No SpO₂ is calculated.**

This approach uses the MAX30102's documented FIFO and sample averaging and the beat-interval principle described by [Analog Devices](https://support.analog.com/en-US/knowledgebase/article/000101121). [SparkFun's example](https://github.com/sparkfun/SparkFun_MAX3010x_Sensor_Library/blob/master/examples/Example5_HeartRate/Example5_HeartRate.ino) informs the contact threshold but explicitly does not establish medical accuracy. See [MAX30102 datasheet](https://www.analog.com/media/en/technical-documentation/data-sheets/MAX30102.pdf). The firmware's native tests use synthetic waveforms to check rejection and timing; they do not validate accuracy on people.

## Failure behavior

LEDs start off, only one compartment channel can be selected, and a lease expires even if the Pi disappears. Lid close clears lights and pulse streaming. Ten seconds without Pi serial traffic clears active lights, rhythm and buzzer state; the Pi reconnects and pings after USB loss. The sensor is probed every two seconds, so a reconnected breakout can recover; a missing sensor never yields a made-up reading. A read interrupted by lid close or sensor loss returns unavailable. An unwired buzzer command is rejected as unsupported. The ESP32 never claims an emergency call happened.

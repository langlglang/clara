# Clara ESP32 firmware

Adapted from Sophi (github.com/mzhao1599/sophi), firmware/README.md and the firmware layout (pure logic in `lib/`, pins in `src/`, native tests in `test/`).

**Status:** written, not built or flashed. PlatformIO was not installed when this was written, and every pin below is a **placeholder** to confirm when the board and parts arrive.

The ESP32-WROOM-32 dev board sits on the Pi's USB. It reports the lid and wall-mount switches, lights one LED per kit compartment, flashes all LEDs in a CPR rhythm, drives a buzzer, and reads a MAX30102 pulse sensor. It never decides anything: the Pi does.

```text
firmware/
  platformio.ini     esp32 (the board) and native (host tests) environments, pinned versions
  src/main.cpp       pins, serial JSON (ArduinoJson), LEDC PWM, switches, MAX30102 (SparkFun library)
  lib/clara/         Arduino-free logic: debounce, lights (lease, modes, rhythm), buzzer patterns,
                     pulse estimator, serial line framing
  test/test_logic/   native Unity tests for lib/clara
```

```sh
pio run -e esp32 -t upload        # build and flash
pio device monitor -b 115200      # watch the JSON lines
pio test -e native                # logic tests on your computer
```

## Wire protocol

Newline-delimited JSON, at most 1,024 bytes a line, 115200 baud, exactly as in [`packages/contracts/src/serial.ts`](../packages/contracts/src/serial.ts).

- **Boot:** `{"t":"hello","fw":"clara-0.1.0","boot":"<8 hex>","leds":6}`, then the lid (and mount) state once the switches have settled.
- **Every command gets an ack** by its `id`: `{"t":"ack","id":7,"ok":true}` or `{"t":"ack","id":7,"ok":false,"err":"lid_closed"}`. A line that isn't JSON or has no integer `id` is dropped (there is no id to ack).
- **`ping`** is acked, then answered with `hello`, `lid` and `mount`, so a Pi that restarted while the board kept running learns the state. The Pi pings every 3 s.
- **`seq`** counts every `lid`/`mount`/`pulse` line and starts again at 0 on reset; `boot` changes on every reset.
- Errors in `err`: `bad_args`, `no_such_channel`, `lid_closed`, `pulse_sensor_missing`, `unknown_command`.

## Behaviour

| Feature | Rule |
| --- | --- |
| LEDs | All off at boot. `led` lights exactly one channel (others off) for `ms` (capped at 30 s, the proposed maximum in docs/contracts.md); `solid`, `blink` (1 Hz) or `pulse` (1.6 s breath). `ch: -1` clears. Refused (`lid_closed`) while the lid is closed (build flag `CLARA_LED_REQUIRE_LID_OPEN`). |
| Rhythm | `rhythm` flashes **all** LEDs 120 ms on each beat at `bpm` (CPR coach); `0` stops it. It wins over a lit compartment while it runs. An SOS flash (· · · — — — · · ·) is implemented and selected by an optional `"pattern":"sos"` field the current contract does not yet carry. |
| Buzzer | Off at boot. `chime` (two rising notes, 0.35 s), `alert` (2 kHz beeps, stops by itself after 10 s), `off` (immediately). Active buzzer by default; set `CLARA_BUZZER_PASSIVE=1` for a passive one (LEDC tone). |
| Lid / mount | Debounced (30 ms placeholder) with the internal pull-up; one line per real change, plus the boot state. `CLARA_MOUNT_SWITCH=0` if no mount switch is wired (then no `mount` lines). |
| Pulse | Sensor off until `pulse.start`; one `pulse` line a second until `pulse.stop`. `bpm` is a number **only** when `quality` is `valid`: a finger on the sensor (IR ≥ 50,000), ≥ 4 beat intervals in 30–200 bpm, all within 15 % of their mean, last beat < 2.5 s ago. A finger with too few, irregular or stale beats is `suspect` with `bpm: null`; no finger or no sensor is `unavailable` with `bpm: null`. The thresholds come from SparkFun's example and are untested against a reference; Clara is a demo, never used on a patient. |
| Safety | Lid close, a silent Pi (no byte for 10 s) and reset turn LEDs, rhythm and buzzer off (and stop the sensor on a silent Pi). |

## Wiring (placeholders: confirm against the delivered board's pinout)

Avoided: strapping pins GPIO0, 2, 5, 12, 15; flash pins 6–11; UART0 (USB serial) 1 and 3; input-only 34–39 (no internal pull-ups).

| ESP32 pin | Goes to | Notes |
| --- | --- | --- |
| GPIO32 | Lid limit switch (COM/NO), other leg to GND | Internal pull-up. Assumed pressed (LOW) when the lid is **closed**; flip `kLidOpenLevel` if wired the other way. |
| GPIO33 | Wall-mount switch, other leg to GND | Internal pull-up. Pressed (LOW) = on the wall. |
| GPIO21 (SDA) | MAX30102 SDA | Default I²C pins. Most breakouts have pull-ups; else 4.7 kΩ to 3.3 V. |
| GPIO22 (SCL) | MAX30102 SCL | Bus runs at 400 kHz. |
| 3V3 / GND | MAX30102 VIN / GND | Check the breakout's VIN range (many take 3.3–5 V). |
| GPIO4 | LED channel 0 | Each LED: GPIO → resistor (start 330 Ω) → anode; cathode → GND. |
| GPIO13 | LED channel 1 | |
| GPIO16 | LED channel 2 | Free on WROOM-32 (used for PSRAM only on WROVER). |
| GPIO17 | LED channel 3 | Same. |
| GPIO18 | LED channel 4 | |
| GPIO19 | LED channel 5 | |
| GPIO23 | LED channel 6 | Only with `CLARA_LED_COUNT` ≥ 7. |
| GPIO26 | LED channel 7 | Only with `CLARA_LED_COUNT` = 8. |
| GPIO25 | Buzzer + (through an NPN/MOSFET if it draws over ~12 mA or needs 5 V) | Never put 5 V on an ESP32 pin. |
| Spare | GPIO14, GPIO27 | GPIO14 outputs a brief PWM at boot: fine for a switch input, not ideal for an LED. |

The LED count is a build flag (`CLARA_LED_COUNT`, default 6 for the 6-compartment demo tray). The 12 V LED candidate cannot be driven from these pins directly (docs/hardware-power.md).

## Still to check on hardware

- The board's USB bridge (CP2102 or CH340) and that the Pi finds it (`npx tsx box/src/check/index.ts`).
- Whether opening the port resets the board (DTR/RTS auto-reset): harmless either way, since the Pi pings.
- Every LED channel against its printed slot (`check --leds`), the lid direction (`check --lid`), the buzzer (`check --beep`).
- The MAX30102 address/answer and whether the finger threshold and beat detector give stable readings (`check --pulse`).

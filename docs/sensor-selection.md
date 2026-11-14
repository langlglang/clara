# Selected wired sensor for Clara's proof of concept

**Status:** [Amazon MAX30102 breakout pack](https://www.amazon.com/dp/B07ZQNC8XP) selected by the team on 2026-11-03; wiring and readings are unverified. Clara is a HackPrinceton demo with consenting volunteers and fictional scenarios. It will never be used on a patient.

## What this part provides

The [MAX30102 manufacturer's page](https://www.analog.com/en/products/MAX30102.html) describes an optical sensor that exposes red and infrared photoplethysmography samples. The selected Amazon listing says the breakout uses I²C, includes two boards and loose pin headers, and has a selectable I²C pull-up level. The board does **not** provide a ready-to-use heart-rate or SpO₂ number. Those values require software processing of a window of live samples and checks for finger contact and signal quality. Do not present a computed value as a measurement directly reported by the chip. The demo can first show a live optical waveform or sample count from hardware; a numeric pulse display is a later acceptance target after its algorithm is checked.

## Proposed connection

1. Inspect the delivered boards and solder the included headers if needed. Set/check the breakout's I²C pull-ups for **3.3 V** before connecting the ESP32. Verify VIN, GND, SDA and SCL pins from the delivered board. Never put a 5 V I²C signal on an ESP32 GPIO.
2. Connect the breakout to non-bootstrapping ESP32 I²C pins; the ESP32 and Pi remain connected by the selected USB-A↔USB-C data cable. A direct Pi 3.3 V I²C connection is an alternative if the enclosure exposes the Pi header.
3. After a volunteer consents and starts a read, `sensor.read` requests a new sample window. Every delivered sample must follow the request and carry a new sequence/monotonic time. Timeout, no finger, disconnected I²C or implausible format returns `unavailable`; never substitute a fixture or the previous volunteer's result. See [contracts](contracts.md).
4. If a pulse algorithm is added, record its version and the raw-sample window used. Check with a known reference and repeated volunteers for demo reliability before displaying bpm. SpO₂ is out of scope for the initial demo. The agent never diagnoses or chooses a fictional care step from this number.

## ESP32 pulse-processing blueprint (proposed, not implemented)

The ESP32 can run this small signal-processing loop locally; it does not need the Pi or cloud to calculate pulse. The [MAX30102 datasheet](https://www.analog.com/media/en/technical-documentation/data-sheets/MAX30102.pdf) describes its I²C output and 32-sample FIFO. [Analog Devices' MAXREFDES117](https://www.analog.com/en/resources/reference-designs/maxrefdes117.html) provides example C source and test data, and the [SparkFun MAX3010x library](https://github.com/sparkfun/SparkFun_MAX3010x_Sensor_Library) says it supports MAX30102. Start from a reviewed reference implementation rather than inventing an unexplained formula.

1. Configure a known sampling rate, for example 100 samples/second, and LED settings on the delivered board. Drain the FIFO often enough to avoid overrun; at 100 samples/second, 32 slots represent only 0.32 seconds. Time-stamp samples with ESP32 monotonic time and detect dropped samples.
2. Keep a short ring buffer of live IR samples. Estimate and remove the steady optical baseline, filter noise, and find repeated pulse peaks with plausible spacing. Compute `bpm = 60 / median_seconds_between_accepted_peaks`. For example, peaks 0.75 seconds apart imply 80 bpm. This is ordinary signal processing; no trained model or labeled dataset is required.
3. Before emitting bpm, require stable finger contact, enough accepted beats, reasonable peak agreement, no FIFO overrun and a fresh sample window. Otherwise send `unavailable` with a reason. Do not turn missing samples into zero, reuse an old person's result, or report a value because a demo script expects one.
4. Send `{model, bpm, unit, window_start_uptime_ms, window_end_uptime_ms, quality, algorithm_version}` over the existing ESP32→Pi USB serial link. The Pi displays the result and sends it to the agent only with session consent. Keep raw samples locally unless a consented diagnostic capture is explicitly needed.

Code generation can speed up the implementation, but **real sensor traces are needed to tune and check it**. Bench checks should include finger on/off, motion, varying pressure, ambient light, repeated volunteers, a simple independent pulse reference, and cable/restart failures. Record the reference code version and test conditions. Treat the first numeric reading as a demo result, not a validated medical measurement. SpO₂ needs a different red/IR calculation and stronger calibration evidence, so leave it out of the initial demo.

Test finger placement/removal, loose wire, ESP32 restart, serial reconnect, timeout, poor optical signal and consent withdrawal. Do not put raw samples or inferred values in ordinary logs. The [FDA's pulse-oximeter overview](https://www.fda.gov/medical-devices/products-and-medical-procedures/pulse-oximeters) explains limits of optical oxygen measurements; this maker breakout has no medical suitability claim.

The previously discussed [DFRobot SEN0344 V2](https://www.dfrobot.com/product-2164.html) and [SparkFun processed board](https://www.sparkfun.com/sparkfun-pulse-oximeter-and-heart-rate-sensor-max30101-max32664-qwiic.html) remain unselected alternatives if the team later changes the BOM. A change of board requires updating the adapter, contracts, power map and verification notes.

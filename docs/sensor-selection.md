# Selected wired sensor for Clara's proof of concept

**Status:** [Amazon MAX30102 breakout pack](https://www.amazon.com/dp/B07ZQNC8XP) is wired to the ESP32. On 2026-11-14, firmware `clara-0.2.1` produced 16 valid finger-on pulse reports in 20 seconds and no BPM without a finger; independent accuracy and the spoken Clara flow remain unverified. Clara is a HackPrinceton demo with consenting volunteers and fictional scenarios. It will never be used on a patient.

## What this part provides

The [MAX30102 manufacturer's page](https://www.analog.com/en/products/MAX30102.html) describes an optical sensor that exposes red and infrared photoplethysmography samples. The selected Amazon listing says the breakout uses I²C, includes two boards and loose pin headers, and has a selectable I²C pull-up level. The board does **not** provide a ready-to-use heart-rate or SpO₂ number. Firmware computes a pulse estimate from live optical samples and checks finger contact and signal quality. Do not present that estimate as a number directly reported by the chip.

## Current connection and read

The breakout uses 3.3 V I²C at ESP32 GPIO21/SDA and GPIO22/SCL. The ESP32 and Pi communicate through their USB cable. Never put a 5 V I²C signal on an ESP32 GPIO. When Clara requests a pulse read, the Pi starts a bounded hardware window and accepts a BPM only from a new `pulse` event marked `quality:valid`; missing, suspect and stale results have no number. A diagnostic `sensor.read` command returns a fresh red/IR sample with sequence and uptime, not a BPM. See [serial contracts](contracts.md) and [firmware notes](../firmware/README.md).

## ESP32 pulse processing (demo implemented; hardware path verified)

The ESP32 runs this signal-processing loop locally; it does not need the Pi or cloud to calculate pulse. The [MAX30102 datasheet](https://www.analog.com/media/en/technical-documentation/data-sheets/MAX30102.pdf) describes its I²C output and 32-sample FIFO. The build uses [SparkFun's MAX3010x driver](https://github.com/sparkfun/SparkFun_MAX3010x_Sensor_Library) for device access; Clara's estimator is a small, versioned algorithm in `firmware/lib/clara/pulse_estimator.cpp`, not a validated clinical algorithm.

The sensor converts at 100 samples/s and averages four samples per FIFO record, giving a 25 Hz stream. Firmware drains the FIFO, checks timing and contact, removes the IR baseline, smooths three records, and detects downward troughs. A BPM is the median of recent beat intervals only when four of five agree within 18%, including the newest. The serial `pulse` event contains BPM or null, quality and sequence; the `hello` identifies firmware version. Raw samples are not logged or retained by the box.

The initial real traces were used to tune the polarity and consistency gate. Next checks are a separate pulse reference, repeated volunteers, motion, varying pressure, ambient light and cable/restart failures. The reported BPM is a demo estimate, not a validated medical measurement. SpO₂ remains out of scope.

Test finger placement/removal, loose wire, ESP32 restart, serial reconnect, timeout, poor optical signal and consent withdrawal. Do not put raw samples or inferred values in ordinary logs. The [FDA's pulse-oximeter overview](https://www.fda.gov/medical-devices/products-and-medical-procedures/pulse-oximeters) explains limits of optical oxygen measurements; this maker breakout has no medical suitability claim.

The previously discussed [DFRobot SEN0344 V2](https://www.dfrobot.com/product-2164.html) and [SparkFun processed board](https://www.sparkfun.com/sparkfun-pulse-oximeter-and-heart-rate-sensor-max30101-max32664-qwiic.html) remain unselected alternatives if the team later changes the BOM. A change of board requires updating the adapter, contracts, power map and verification notes.

// Adapted from Sophi (github.com/mzhao1599/sophi), firmware/src/hand/main.cpp and firmware/src/common/board_serial.h.
//
// Clara's ESP32-WROOM-32: reports the lid and wall-mount switches, lights one compartment LED at a time, runs
// the all-LED CPR rhythm or SOS flash, drives the buzzer, and reads the MAX30102 pulse sensor. It speaks the
// newline JSON contract in packages/contracts/src/serial.ts at 115200 baud and acks every command by id.
//
// Safety rules (docs/subsystems/firmware.md, docs/contracts.md):
// - every LED and the buzzer start off;
// - lid close, a silent Pi (no line for kLinkWatchdogMs) and reset turn lights, rhythm and buzzer off;
// - LED and rhythm commands are refused while the lid is closed (CLARA_LED_REQUIRE_LID_OPEN);
// - a pulse bpm is sent only with quality "valid"; otherwise it is null. Never a made-up number.
//
// Pins are placeholders until the board is wired; see README.md. Not yet built or run on hardware.
#include <Arduino.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <esp_system.h>

#include "MAX30105.h"
#include "heartRate.h"
#include "buzzer.h"
#include "debounce.h"
#include "lights.h"
#include "line_buffer.h"
#include "pulse_estimator.h"

#ifndef CLARA_LED_COUNT
#define CLARA_LED_COUNT 6
#endif
#ifndef CLARA_LED_REQUIRE_LID_OPEN
#define CLARA_LED_REQUIRE_LID_OPEN 1
#endif
#ifndef CLARA_MOUNT_SWITCH
#define CLARA_MOUNT_SWITCH 1
#endif
#ifndef CLARA_BUZZER_PASSIVE
#define CLARA_BUZZER_PASSIVE 0
#endif

namespace {

constexpr const char* kFirmware = "clara-0.1.0";
constexpr unsigned long kBaud = 115200;

// ---- Pins (placeholders; avoid strapping pins 0, 2, 5, 12, 15, flash pins 6-11, and UART0 pins 1, 3) ----
// Switches go between the pin and GND with the internal pull-up (34-39 have none, so they are not used).
constexpr uint8_t kLidPin = 32;
constexpr uint8_t kMountPin = 33;
// Roller-lever switch wired normally-open, pressed by the closed lid: closed lid pulls the pin LOW.
constexpr bool kLidOpenLevel = HIGH;
// Mount switch pressed by the wall bracket: on the wall pulls the pin LOW.
constexpr bool kOnWallLevel = LOW;
// One LED per compartment: GPIO -> series resistor (start at 330 ohm) -> LED anode; cathode -> GND.
constexpr uint8_t kLedPins[8] = {4, 13, 16, 17, 18, 19, 23, 26};
constexpr uint8_t kBuzzerPin = 25;
constexpr int kSdaPin = 21;
constexpr int kSclPin = 22;

static_assert(CLARA_LED_COUNT >= 1 && CLARA_LED_COUNT <= 8, "CLARA_LED_COUNT must be 1..8 with these pins");

// ---- PWM (LEDC, Arduino-ESP32 core 2.0.x API) ----
constexpr uint32_t kLedPwmHz = 5000;
constexpr uint8_t kLedPwmBits = 8;
// Channels 0-7 for the LEDs; the buzzer gets channel 14 (a low-speed timer the LEDs don't use).
constexpr uint8_t kBuzzerPwmChannel = 14;

// ---- Timing (placeholders, not measured) ----
constexpr uint32_t kLinkWatchdogMs = 10000;  // the Pi pings every 3 s
constexpr uint32_t kPulseReportMs = 1000;

clara::Lights lights(CLARA_LED_COUNT);
clara::Buzzer buzzer;
clara::Debouncer lidSwitch;
clara::Debouncer mountSwitch;
clara::LineBuffer input;
clara::PulseEstimator pulse;
MAX30105 sensor;

char bootId[9] = {};
uint32_t seq = 0;
bool lidKnown = false;
bool lidOpen = false;
bool mountKnown = false;
bool onWall = false;
uint32_t lastFromPi = 0;
bool sensorFound = false;
bool pulseRunning = false;
uint32_t lastPulseReport = 0;
uint8_t lastLevels[8] = {};
uint16_t lastTone = 0xFFFF;

// ---- output ----

// Writes a whole line or nothing, so the loop never blocks on a slow port.
void sendDoc(JsonDocument& doc) {
  char out[clara::kMaxLine];
  const size_t n = serializeJson(doc, out, sizeof out - 1);
  if (n == 0 || n >= sizeof out - 1) return;
  out[n] = '\n';
  if (Serial.availableForWrite() < static_cast<int>(n + 1)) return;
  Serial.write(reinterpret_cast<const uint8_t*>(out), n + 1);
}

void sendHello() {
  JsonDocument doc;
  doc["t"] = "hello";
  doc["fw"] = kFirmware;
  doc["boot"] = bootId;
  doc["leds"] = CLARA_LED_COUNT;
  sendDoc(doc);
}

void sendLid() {
  if (!lidKnown) return;
  JsonDocument doc;
  doc["t"] = "lid";
  doc["open"] = lidOpen;
  doc["seq"] = seq++;
  sendDoc(doc);
}

void sendMount() {
  if (!mountKnown) return;
  JsonDocument doc;
  doc["t"] = "mount";
  doc["on_wall"] = onWall;
  doc["seq"] = seq++;
  sendDoc(doc);
}

void sendPulse(const clara::PulseResult& result) {
  JsonDocument doc;
  doc["t"] = "pulse";
  if (result.quality == clara::PulseQuality::Valid && result.bpm >= 0) doc["bpm"] = result.bpm;
  else doc["bpm"] = nullptr;
  doc["quality"] = clara::pulseQualityName(result.quality);
  doc["seq"] = seq++;
  sendDoc(doc);
}

void ack(long id, bool ok, const char* err = nullptr) {
  JsonDocument doc;
  doc["t"] = "ack";
  doc["id"] = id;
  doc["ok"] = ok;
  if (!ok && err) doc["err"] = err;
  sendDoc(doc);
}

// ---- hardware ----

void writeBuzzer(uint16_t hz) {
  if (hz == lastTone) return;
  lastTone = hz;
#if CLARA_BUZZER_PASSIVE
  ledcWriteTone(kBuzzerPwmChannel, hz);
#else
  // An active buzzer makes its own tone: any non-zero frequency means on.
  digitalWrite(kBuzzerPin, hz ? HIGH : LOW);
#endif
}

void quiet() {
  lights.clear();
  buzzer.stop();
  writeBuzzer(0);
}

void startPulse() {
  pulse.reset();
  pulseRunning = true;
  lastPulseReport = millis();
  if (sensorFound) sensor.wakeUp();
}

void stopPulse() {
  pulseRunning = false;
  pulse.reset();
  if (sensorFound) sensor.shutDown();
}

void readPulse(uint32_t now) {
  if (!pulseRunning) return;
  if (sensorFound) {
    sensor.check();  // non-blocking: moves new FIFO samples into the library's buffer
    while (sensor.available()) {
      const uint32_t ir = sensor.getFIFOIR();
      sensor.nextSample();
      const bool beat = ir >= clara::kFingerIr && checkForBeat(static_cast<long>(ir));
      pulse.sample(ir, beat, now);
    }
  }
  if (now - lastPulseReport >= kPulseReportMs) {
    lastPulseReport = now;
    sendPulse(sensorFound ? pulse.result(now) : clara::PulseResult{-1, clara::PulseQuality::Unavailable});
  }
}

// ---- commands ----

bool isInt(JsonVariantConst value, long min, long max) {
  if (!value.is<long>()) return false;
  const long v = value.as<long>();
  return v >= min && v <= max;
}

void handleLine(const char* line, size_t length) {
  JsonDocument doc;
  if (deserializeJson(doc, line, length)) return;  // Not JSON: no id to ack.
  JsonVariantConst idValue = doc["id"];
  if (!isInt(idValue, 0, 2147483647L)) return;
  const long id = idValue.as<long>();
  const char* t = doc["t"] | "";
  const uint32_t now = millis();

  if (strcmp(t, "ping") == 0) {
    ack(id, true);
    // Answering with hello and the switch states lets a Pi that restarted learn them without a reset.
    sendHello();
    sendLid();
    sendMount();
    return;
  }
  if (strcmp(t, "led") == 0) {
    clara::LedMode mode;
    if (!isInt(doc["ch"], -1, 15) || !isInt(doc["ms"], 0, 60000) || !clara::parseLedMode(doc["mode"] | "", &mode)) return ack(id, false, "bad_args");
    const int ch = doc["ch"].as<int>();
    if (ch == -1) {
      lights.clearCompartment();
      return ack(id, true);
    }
    if (ch >= CLARA_LED_COUNT) return ack(id, false, "no_such_channel");
#if CLARA_LED_REQUIRE_LID_OPEN
    if (!lidOpen) return ack(id, false, "lid_closed");
#endif
    lights.light(ch, doc["ms"].as<uint32_t>(), mode, now);
    return ack(id, true);
  }
  if (strcmp(t, "rhythm") == 0) {
    if (!isInt(doc["bpm"], 0, 200)) return ack(id, false, "bad_args");
    const uint16_t bpm = doc["bpm"].as<uint16_t>();
    // Optional "pattern": "sos" is read for a future contract version; today's Pi never sends it.
    const char* pattern = doc["pattern"] | "beat";
    const clara::RhythmPattern which = strcmp(pattern, "sos") == 0 ? clara::RhythmPattern::Sos : clara::RhythmPattern::Beat;
#if CLARA_LED_REQUIRE_LID_OPEN
    if (bpm > 0 && !lidOpen) return ack(id, false, "lid_closed");
#endif
    lights.rhythm(bpm, which, now);
    return ack(id, true);
  }
  if (strcmp(t, "buzz") == 0) {
    clara::BuzzPattern pattern;
    if (!clara::parseBuzzPattern(doc["pattern"] | "", &pattern)) return ack(id, false, "bad_args");
    if (pattern == clara::BuzzPattern::Off) {
      buzzer.stop();
      writeBuzzer(0);
    } else {
      buzzer.start(pattern, now);
    }
    return ack(id, true);
  }
  if (strcmp(t, "pulse.start") == 0) {
    startPulse();
    if (!sensorFound) return ack(id, false, "pulse_sensor_missing");
    return ack(id, true);
  }
  if (strcmp(t, "pulse.stop") == 0) {
    stopPulse();
    return ack(id, true);
  }
  ack(id, false, "unknown_command");
}

void pumpSerial(uint32_t now) {
  // At most 256 bytes per loop so the LEDs and switches stay responsive.
  for (int i = 0; i < 256 && Serial.available() > 0; ++i) {
    const int byte = Serial.read();
    if (byte < 0) break;
    lastFromPi = now;
    if (input.push(static_cast<uint8_t>(byte))) handleLine(input.line(), input.length());
  }
}

// ---- switches ----

void readSwitches(uint32_t now) {
  if (lidSwitch.update(digitalRead(kLidPin) == kLidOpenLevel, now) == clara::Debouncer::Result::Changed) {
    lidOpen = lidSwitch.level();
    lidKnown = true;
    if (!lidOpen) quiet();  // Lid closed: nothing stays lit or sounding.
    sendLid();
  }
#if CLARA_MOUNT_SWITCH
  if (mountSwitch.update(digitalRead(kMountPin) == kOnWallLevel, now) == clara::Debouncer::Result::Changed) {
    onWall = mountSwitch.level();
    mountKnown = true;
    sendMount();
  }
#endif
}

void writeOutputs(uint32_t now) {
  lights.update(now);
  for (uint8_t ch = 0; ch < CLARA_LED_COUNT; ++ch) {
    const uint8_t level = lights.level(ch, now);
    if (level != lastLevels[ch]) {
      lastLevels[ch] = level;
      ledcWrite(ch, level);
    }
  }
  writeBuzzer(buzzer.tone(now));
}

}  // namespace

void setup() {
  // Outputs off before anything else.
  for (uint8_t ch = 0; ch < CLARA_LED_COUNT; ++ch) {
    pinMode(kLedPins[ch], OUTPUT);
    digitalWrite(kLedPins[ch], LOW);
    ledcSetup(ch, kLedPwmHz, kLedPwmBits);
    ledcAttachPin(kLedPins[ch], ch);
    ledcWrite(ch, 0);
  }
#if CLARA_BUZZER_PASSIVE
  ledcSetup(kBuzzerPwmChannel, 2000, 8);
  ledcAttachPin(kBuzzerPin, kBuzzerPwmChannel);
  ledcWriteTone(kBuzzerPwmChannel, 0);
#else
  pinMode(kBuzzerPin, OUTPUT);
  digitalWrite(kBuzzerPin, LOW);
#endif
  writeBuzzer(0);
  pinMode(kLidPin, INPUT_PULLUP);
#if CLARA_MOUNT_SWITCH
  pinMode(kMountPin, INPUT_PULLUP);
#endif

  Serial.setRxBufferSize(2048);
  Serial.setTxBufferSize(2048);
  Serial.begin(kBaud);

  snprintf(bootId, sizeof bootId, "%08lx", static_cast<unsigned long>(esp_random()));

  Wire.begin(kSdaPin, kSclPin);
  sensorFound = sensor.begin(Wire, I2C_SPEED_FAST);
  if (sensorFound) {
    // SparkFun's heart-rate example settings: red LED low (a "sensor on" glow), IR for the beat detector.
    sensor.setup();
    sensor.setPulseAmplitudeRed(0x0A);
    sensor.setPulseAmplitudeGreen(0);
    sensor.shutDown();  // Off until the Pi asks for a reading.
  }

  sendHello();
  lastFromPi = millis();
}

void loop() {
  const uint32_t now = millis();
  pumpSerial(now);
  readSwitches(now);
  // The Pi went quiet (unplugged, crashed): leave nothing lit or sounding, and stop the sensor.
  if (now - lastFromPi > kLinkWatchdogMs && (lights.anyOn() || buzzer.on() || pulseRunning)) {
    quiet();
    if (pulseRunning) stopPulse();
  }
  readPulse(now);
  writeOutputs(now);
}

// Adapted from Sophi (github.com/mzhao1599/sophi), firmware/test/test_module/test_main.cpp.
// Native tests for lib/clara on a fake clock: pio test -e native. Not run yet (PlatformIO not installed).
#include <unity.h>

#include <cstring>
#include <cmath>

#include "buzzer.h"
#include "debounce.h"
#include "lights.h"
#include "line_buffer.h"
#include "pulse_estimator.h"

using namespace clara;

void setUp() {}
void tearDown() {}

void test_debounce_reports_first_level_and_one_change_through_bounce() {
  Debouncer d(30);
  TEST_ASSERT_TRUE(d.update(true, 0) == Debouncer::Result::None);
  TEST_ASSERT_TRUE(d.update(true, 30) == Debouncer::Result::Changed);  // the state at boot
  TEST_ASSERT_TRUE(d.level());
  int changes = 0;
  for (uint32_t t = 40; t < 60; t += 2) changes += d.update((t / 2) % 2 == 0, t) == Debouncer::Result::Changed;
  for (uint32_t t = 60; t < 200; t += 5) changes += d.update(false, t) == Debouncer::Result::Changed;
  TEST_ASSERT_EQUAL(1, changes);
  TEST_ASSERT_FALSE(d.level());
}

void test_lights_one_at_a_time_and_lease() {
  Lights l(6);
  TEST_ASSERT_TRUE(l.light(1, 1000, LedMode::Solid, 0));
  TEST_ASSERT_TRUE(l.light(2, 1000, LedMode::Solid, 10));
  TEST_ASSERT_EQUAL(0, l.level(1, 20));
  TEST_ASSERT_EQUAL(255, l.level(2, 20));
  l.update(1009);
  TEST_ASSERT_EQUAL(2, l.litChannel());
  l.update(1010);
  TEST_ASSERT_EQUAL(-1, l.litChannel());
  TEST_ASSERT_FALSE(l.light(6, 1000, LedMode::Solid, 0));
  TEST_ASSERT_FALSE(l.light(-1, 1000, LedMode::Solid, 0));
}

void test_lights_lease_capped_and_modes() {
  Lights l(6);
  l.light(0, 60000, LedMode::Blink, 0);
  TEST_ASSERT_EQUAL(255, l.level(0, 100));
  TEST_ASSERT_EQUAL(0, l.level(0, 600));
  l.update(kMaxLeaseMs);
  TEST_ASSERT_EQUAL(-1, l.litChannel());
  l.light(0, 5000, LedMode::Pulse, 0);
  TEST_ASSERT_TRUE(l.level(0, 0) > 0);
  TEST_ASSERT_EQUAL(255, l.level(0, kBreathPeriodMs / 2));
}

void test_rhythm_drives_every_led_and_stops() {
  Lights l(4);
  l.light(1, 5000, LedMode::Solid, 0);
  TEST_ASSERT_TRUE(l.rhythm(100, RhythmPattern::Beat, 0));  // 600 ms period
  for (uint8_t ch = 0; ch < 4; ++ch) TEST_ASSERT_EQUAL(255, l.level(ch, 50));
  TEST_ASSERT_EQUAL(0, l.level(0, 300));
  TEST_ASSERT_EQUAL(255, l.level(0, 650));
  TEST_ASSERT_FALSE(l.rhythm(201, RhythmPattern::Beat, 0));
  l.rhythm(0, RhythmPattern::Beat, 0);
  TEST_ASSERT_EQUAL(255, l.level(1, 700));  // back to the compartment
  l.rhythm(1, RhythmPattern::Sos, 0);
  TEST_ASSERT_TRUE(l.rhythmOn());
  TEST_ASSERT_EQUAL(255, l.level(0, 0));    // first dot
  TEST_ASSERT_EQUAL(0, l.level(0, 250));    // gap
  l.clear();
  TEST_ASSERT_FALSE(l.anyOn());
}

void test_buzzer_chime_ends_and_alert_is_bounded() {
  Buzzer b;
  b.start(BuzzPattern::Chime, 0);
  TEST_ASSERT_EQUAL(880, b.tone(10));
  TEST_ASSERT_EQUAL(1320, b.tone(200));
  TEST_ASSERT_EQUAL(0, b.tone(400));
  TEST_ASSERT_FALSE(b.on());
  b.start(BuzzPattern::Alert, 0);
  TEST_ASSERT_EQUAL(2000, b.tone(100));
  TEST_ASSERT_EQUAL(0, b.tone(kAlertMaxMs));
  TEST_ASSERT_FALSE(b.on());
  b.start(BuzzPattern::Alert, 0);
  b.stop();
  TEST_ASSERT_EQUAL(0, b.tone(10));
}

void test_pulse_no_finger_is_unavailable() {
  PulseEstimator p;
  p.sample(1000, 0);
  PulseResult r = p.result(0);
  TEST_ASSERT_EQUAL(-1, r.bpm);
  TEST_ASSERT_TRUE(r.quality == PulseQuality::Unavailable);
}

void feedPulse(PulseEstimator& p, uint32_t durationMs, uint32_t periodMs) {
  for (uint32_t t = 0; t <= durationMs; t += 40) {
    const float phase = 6.2831853f * static_cast<float>(t % periodMs) / periodMs;
    const uint32_t ir = static_cast<uint32_t>(100000.0f + 2500.0f * std::sin(phase));
    p.sample(ir, t);
  }
}

void test_pulse_steady_waveform_is_valid() {
  PulseEstimator p;
  feedPulse(p, 8000, 800);  // Synthetic 75 bpm optical waveform at 25 FIFO records/s.
  PulseResult r = p.result(8000);
  TEST_ASSERT_TRUE(r.quality == PulseQuality::Valid);
  TEST_ASSERT_EQUAL(75, r.bpm);
  TEST_ASSERT_TRUE(p.result(8300).quality == PulseQuality::Unavailable);  // No new FIFO records.
}

void test_pulse_flat_noisy_or_broken_signal_never_reports_a_number() {
  PulseEstimator p;
  for (uint32_t t = 0; t <= 8000; t += 40) p.sample(100000 + (t % 3) * 10, t);
  TEST_ASSERT_TRUE(p.result(8000).quality != PulseQuality::Valid);
  TEST_ASSERT_EQUAL(-1, p.result(8000).bpm);
  feedPulse(p, 8000, 800);
  p.sample(100000, 8300);  // Lost FIFO records; old beat times cannot be reused.
  TEST_ASSERT_EQUAL(-1, p.result(8300).bpm);
  p.sample(261000, 8340);  // 18-bit ADC saturation.
  TEST_ASSERT_TRUE(p.result(8340).quality == PulseQuality::Unavailable);
  p.sample(100, 8380);  // Finger lifted.
  TEST_ASSERT_TRUE(p.result(8380).quality == PulseQuality::Unavailable);
}

void test_line_buffer_frames_and_drops_oversize() {
  LineBuffer b;
  const char* text = "{\"t\":\"ping\",\"id\":1}\r\n";
  bool ready = false;
  for (const char* c = text; *c; ++c) ready = b.push(static_cast<uint8_t>(*c));
  TEST_ASSERT_TRUE(ready);
  TEST_ASSERT_EQUAL_STRING("{\"t\":\"ping\",\"id\":1}", b.line());
  for (size_t i = 0; i < kMaxLine + 5; ++i) TEST_ASSERT_FALSE(b.push('a'));
  TEST_ASSERT_FALSE(b.push('\n'));
  TEST_ASSERT_EQUAL(1, b.oversize());
  TEST_ASSERT_FALSE(b.push('x'));
  TEST_ASSERT_TRUE(b.push('\n'));
  TEST_ASSERT_EQUAL_STRING("x", b.line());
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_debounce_reports_first_level_and_one_change_through_bounce);
  RUN_TEST(test_lights_one_at_a_time_and_lease);
  RUN_TEST(test_lights_lease_capped_and_modes);
  RUN_TEST(test_rhythm_drives_every_led_and_stops);
  RUN_TEST(test_buzzer_chime_ends_and_alert_is_bounded);
  RUN_TEST(test_pulse_no_finger_is_unavailable);
  RUN_TEST(test_pulse_steady_waveform_is_valid);
  RUN_TEST(test_pulse_flat_noisy_or_broken_signal_never_reports_a_number);
  RUN_TEST(test_line_buffer_frames_and_drops_oversize);
  return UNITY_END();
}

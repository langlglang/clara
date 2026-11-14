// Adapted from Sophi (github.com/mzhao1599/sophi), firmware/test/test_module/test_main.cpp.
// Native tests for lib/clara on a fake clock: pio test -e native. Not run yet (PlatformIO not installed).
#include <unity.h>

#include <cstring>

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
  p.sample(1000, false, 0);
  PulseResult r = p.result(0);
  TEST_ASSERT_EQUAL(-1, r.bpm);
  TEST_ASSERT_TRUE(r.quality == PulseQuality::Unavailable);
}

void test_pulse_steady_beats_are_valid() {
  PulseEstimator p;
  uint32_t t = 0;
  for (int i = 0; i < 6; ++i, t += 800) p.sample(90000, true, t);  // 75 bpm
  PulseResult r = p.result(t - 800);
  TEST_ASSERT_TRUE(r.quality == PulseQuality::Valid);
  TEST_ASSERT_EQUAL(75, r.bpm);
  // Stale: no beat for 3 s.
  TEST_ASSERT_TRUE(p.result(t + 3000).quality == PulseQuality::Suspect);
  TEST_ASSERT_EQUAL(-1, p.result(t + 3000).bpm);
}

void test_pulse_irregular_or_few_beats_are_suspect() {
  PulseEstimator p;
  p.sample(90000, true, 0);
  p.sample(90000, true, 800);
  TEST_ASSERT_TRUE(p.result(900).quality == PulseQuality::Suspect);
  const uint32_t times[] = {1300, 2500, 2900, 4200};
  for (uint32_t t : times) p.sample(90000, true, t);
  TEST_ASSERT_TRUE(p.result(4300).quality == PulseQuality::Suspect);
  p.sample(100, false, 4400);  // finger lifted
  TEST_ASSERT_TRUE(p.result(4400).quality == PulseQuality::Unavailable);
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
  RUN_TEST(test_pulse_steady_beats_are_valid);
  RUN_TEST(test_pulse_irregular_or_few_beats_are_suspect);
  RUN_TEST(test_line_buffer_frames_and_drops_oversize);
  return UNITY_END();
}

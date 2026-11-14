// Adapted from Sophi (github.com/mzhao1599/sophi), devices/pi/src/sim/simulate.ts and sim/networkSwitch.ts:
// the whole box on a laptop with simulated parts, a fake cloud unless a server is given, and keys for what a
// person or the network would do. Walker parts (arms, lift, GPS, camera) are dropped.
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Alert, BoxPush } from "@clara/contracts";
import { FakeCloudLink } from "../cloud/fake.js";
import { startBox, type BoxConfig } from "../main.js";
import type { Board } from "../ports.js";
import { textTurn } from "../session/text-turn.js";
import { loadBoard } from "../wiring.js";
import { simResponder } from "./responder.js";

const fixture = (name: string) => fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));

const HELP = `Clara box SIMULATOR. Type a line and press Enter.
  o / c          open / close the lid
  n / b / r      Next / Back / Repeat (touch)
  s / x          SOS / cancel the countdown
  t              Talk button
  :pick <scenario_id>        start-screen scenario picker (e.g. :pick not_breathing)
  :summary  :stopcoach       read the handoff summary / stop the CPR coach
  :accept [name] [minutes]   a volunteer accepts (fake cloud)
  :arrive  :decline          that volunteer arrives / withdraws (fake cloud)
  :msg <text>    a responder message (fake cloud)
  :nearby  :clear            another box's emergency starts / ends (fake cloud)
  :offline  :online          switch the fake link
  :state  :help  :quit
  anything else  what the bystander says (a typed voice turn)`;

type LidBoard = Board & { setLid(open: boolean): void };
const hasLid = (board: Board | null): board is LidBoard => typeof (board as Partial<LidBoard> | null)?.setLid === "function";

export async function runSim(input: BoxConfig): Promise<number> {
  const print = (line: string) => process.stdout.write(`${line}\n`);
  const config: BoxConfig = { ...input };
  if (!config.scenarioPath) {
    config.scenarioPath = fixture("test-scenario.json");
    config.kitPath ??= fixture("test-kit.json");
    print("Using the TEST FIXTURE scenario (placeholder text, not medical content). Set CLARA_SCENARIO for a real one.");
  }
  const fake = config.serverUrl ? null : new FakeCloudLink({ responder: simResponder });
  print(fake ? "Cloud: FAKE (in memory). Pass --server <url> or CLARA_SERVER_URL for a real server." : `Cloud: ${config.serverUrl}`);
  const board = await loadBoard({ sim: true, log: (l) => print(`  ${l}`) });
  const box = await startBox(config, { ...(fake ? { cloud: fake } : {}), board, log: (l) => print(`  ${l}`), print: (l) => print(`  say: ${l}`) });
  const { session, cloud } = box;
  session.onEvent((event) => print(`  event ${event.type}${"step_id" in event ? ` ${event.step_id}` : ""}`));
  board?.onEvent((event) => {
    if ("t" in event && event.t === "lid") print(`  board: lid ${event.open ? "open" : "closed"}`);
  });
  // The fake cloud stands in for the server's incident.opened push (a placeholder link, not a real report).
  if (fake) session.onEvent((event) => {
    if (event.type === "sos.opened") setTimeout(() => fake.push({ type: "incident.opened", incident_id: "inc-sim-1", report_url: "https://clara.living/report/sim-placeholder-token", report_code: "SIM234" }), 0);
  });
  let reportShown: string | null = null;
  session.onView((view) => {
    if (view.report_link && view.report_link !== reportShown) print(`  screen: PARAMEDICS: ${view.report_link}`);
    reportShown = view.report_link;
  });
  if (box.screen) print(`Box screen: ${box.screen.url} (open it in a browser)`);
  print(HELP);

  const incident = "inc-sim-1";
  let alert: Alert | null = null;
  const push = (p: BoxPush) => {
    if (!fake) return print("  (pushes come from the real server; this works with the fake cloud only)");
    fake.push(p);
  };
  const setAlert = (state: Alert["state"], name?: string, eta?: number | null) => {
    const now = new Date().toISOString();
    alert = {
      alert_id: alert?.alert_id ?? "alert-sim-1",
      incident_id: incident,
      volunteer_id: alert?.volunteer_id ?? "vol-sim-1",
      volunteer_name: name ?? alert?.volunteer_name ?? "Amina",
      state,
      eta_minutes: eta === undefined ? (alert?.eta_minutes ?? null) : eta,
      sent_at: alert?.sent_at ?? now,
      updated_at: now,
    };
    push({ type: "alert.update", incident_id: incident, alert });
  };
  const lid = (open: boolean) => {
    if (hasLid(board)) board.setLid(open);
    else if (open) session.lidOpened();
    else session.lidClosed();
  };

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "box> " });
  let pending: Promise<unknown> = Promise.resolve();
  let closed = false;
  const done = new Promise<void>((resolve) => rl.on("close", () => {
    closed = true;
    resolve();
  }));
  rl.prompt();
  rl.on("line", (raw) => {
    pending = pending
      .then(async () => {
        const line = raw.trim();
        const [command, ...rest] = line.split(/\s+/);
        switch (command) {
          case "":
            return;
          case "o":
            return lid(true);
          case "c":
            return lid(false);
          case "n":
            return session.press({ action: "next" });
          case "b":
            return session.press({ action: "back" });
          case "r":
            return session.press({ action: "repeat" });
          case "s":
            return session.press({ action: "sos" });
          case "x":
            return session.press({ action: "cancel_sos" });
          case "t":
            return session.press({ action: "talk" });
          case ":pick":
            return session.press({ action: "pick_scenario", scenario_id: rest[0] ?? "not_breathing" });
          case ":summary":
            return session.press({ action: "read_summary" });
          case ":stopcoach":
            return session.press({ action: "stop_coach" });
          case ":accept":
            return setAlert("coming", rest[0], rest[1] ? Number(rest[1]) : 6);
          case ":arrive":
            return setAlert("arrived");
          case ":decline":
            return setAlert("declined");
          case ":msg":
            return push({ type: "responder.message", incident_id: incident, from: alert?.volunteer_name ?? "Responder", text: rest.join(" ").slice(0, 300) || "On my way." });
          case ":nearby":
            return push({ type: "nearby.emergency", incident_id: "inc-other-1", from_box_id: "box-other", from_box_name: "Room 101", directions: "Ground floor, next to the main stairs." });
          case ":clear":
            return push({ type: "nearby.clear", incident_id: "inc-other-1" });
          case ":offline":
          case ":online":
            if (!fake) return print("  (only the fake link can be switched)");
            return fake.setOnline(command === ":online");
          case ":state": {
            const v = session.view();
            return print(`  phase ${v.phase}; scenario ${v.scenario_id ?? "-"}; step ${v.step?.step_id ?? "-"}; online ${v.online}; coming ${v.coming ?? "-"}; countdown ${v.countdown?.seconds_left ?? "-"}; coach ${v.coach ? `${v.coach.bpm} bpm` : "-"}; report ${v.report_link ?? "-"}`);
          }
          case ":help":
            return print(HELP);
          case ":quit":
            return rl.close();
          default:
            if (line.startsWith(":")) return print("  unknown command (:help)");
            await textTurn(session, cloud, line);
        }
      })
      .catch((error: unknown) => print(`  error: ${(error as Error).message}`))
      .finally(() => {
        if (!closed) rl.prompt();
      });
  });
  await done;
  await pending;
  await box.stop();
  return 0;
}

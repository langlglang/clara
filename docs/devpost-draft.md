# Clara — Your First Aid Copilot

**Elevator pitch:** Clara is an AI-assisted first aid box that helps a bystander focus on the person in front of them. It offers hands-free guidance, lights the right supply compartment, shows relevant visuals, and coordinates a prototype response network in the background.

**Project:** [Live web app](https://clara.living) · [Source code](https://github.com/langlglang/clara)

## Inspiration

When Ella was six, her younger sister started choking at a restaurant. Their grandparents were trying to help her, speak with 911, and find someone nearby who knew what to do—all at once. By luck, a doctor was there, and her sister survived.

That experience stayed with us. In an emergency, the person providing care should not have to juggle instructions, supplies, communication, and finding help. We built Clara to act as a first aid copilot: one voice you can talk to while your attention stays on the person in front of you.

## What it does

Open the lid and Clara is ready for a hands-free conversation. The box can ask a short question, show a preauthored illustration, or light one of its three compartments to point to a stocked item. Its Pi can capture a user-requested camera frame for a cloud visual observation and request a live pulse estimate from the connected ESP32 sensor. If a reading or image is unclear, Clara says so rather than inventing a result.

Clara can keep that conversation going while separate tasks work on the response around it. The prototype can alert opted-in nearby volunteers, accept their responses through the companion app, and prepare a briefing for a team-owned dispatcher phone. The app also helps people find a Clara box or sign up as responders or drivers. The current build **does not dial public emergency services**; its dispatcher call demonstrates the workflow with a team phone.

## How we built it

We laser-cut an acrylic frame and designed and 3D-printed more than thirty custom parts to fit the screen, camera, electronics, and supplies. A Raspberry Pi 5 runs the voice and touchscreen software. An ESP32 watches the lid switch, drives the compartment LEDs, and samples a MAX30102 pulse sensor; the two boards exchange versioned messages over USB. The box has a USB microphone, speaker, camera, touchscreen, and GPS receiver.

The cloud service uses structured agent actions rather than a scripted chat tree. One Core Clara handles the conversation. Separate bounded tasks handle camera inspection, sensor requests, volunteer outreach, and a team-dispatcher workflow, so a slow background task need not stop the conversation. The box checks requested actions against its current kit manifest and guide state before lighting a compartment or showing a visual. The companion app, dispatch dashboard, and box API run in a Next.js service backed by Postgres. We used Cartesia for speech and LangChain's deepagents for the response coordinator.

We also built a placement planner that can use CoStar property and floor data, Matterport walking paths, and Vexcel aerial information to estimate where boxes would cover the most people. The hosted planner needs the licensed source data and service keys for a real-building run.

## How we used our sponsors

**Photon:** We built opt-in text alerts and ride requests for volunteers through Photon. A volunteer can reply with a short acceptance or decline, and that response flows back into Clara's network. Reaching people in channels they already use, including iMessage and WhatsApp where configured, removes the need to keep the companion app open.

**CoStar:** Our placement planner is designed to use property, floor, and occupancy data to compare candidate kit locations. It estimates walking coverage rather than assuming a box is useful simply because it is nearby on a map. A live run on a real building requires the licensed extract and source credentials.

## Challenges we ran into

Making the physical box behave as one system took more work than connecting each part separately. We traced the three LED wires to their actual compartments, dealt with USB power and hub instability, and kept the Pi available so opening the lid feels immediate. The pulse sensor could detect a finger before it could produce a stable estimate, so we worked from raw optical traces and required consistent beats before showing a number.

The voice and camera paths exposed different timing problems. Speaker audio can leak into the microphone, speech can end before an agent turn completes, and a camera frame can capture correctly yet fail during cloud interpretation. We added bounded requests, explicit failure states, and short-lived camera context so a late result does not overwrite a newer conversation. We also learned that a useful visual must arrive in the order a person needs it: first find the gauze, then show how to use it.

## Accomplishments that we're proud of

- We built and connected a physical three-compartment box whose lights correspond to the supplies Clara names.
- The ESP32 and Pi exchange real lid, LED, and sensor messages over USB; a steady finger-on hardware test produced pulse estimates, while an uncovered sensor produced no BPM.
- Clara can keep one user-facing conversation while independent response tasks run in the background.
- We made a companion app and dispatch view that represent volunteer offers, acceptance, and handoff as distinct states. Clara only announces that someone is coming after an acceptance.
- We connected the enclosure, voice, screen, camera, sensor, kit inventory, and cloud into one prototype, with automated contract and scenario tests.

## What we learned

The best assistant in a stressful moment gives the user less to manage. A light over the correct compartment can be more useful than a paragraph, and a visual is valuable only when it appears at the right moment. We also learned to separate what a person reported, what a camera may show, and what hardware actually measured. That distinction is essential when a fast agent is coordinating several tasks at once.

## What's next for Clara

The prototype is for fictional demonstrations, not patient use. Next we would review and version first aid content with qualified experts, evaluate medically suitable monitoring devices, improve battery and offline operation, and test the full voice-to-dispatch flow under unreliable connectivity. Any real emergency calling or field deployment would also require a human-controlled escalation design, privacy and consent work, and regulatory review.

## Submission checks

Before pasting this into Devpost, add the demo video and team credits. Confirm whether a Photon message and reply, a Twilio call answered by the team dispatcher, and a CoStar-backed placement run were demonstrated end to end; the draft deliberately describes those integrations without claiming an unverified live result. The video script should say **team dispatcher** rather than **911** for Clara's call, and **gathers context** rather than **diagnoses** or an unqualified **assesses injuries**.

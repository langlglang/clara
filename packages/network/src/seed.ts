import { VolunteerSchema, type Volunteer } from "@clara/contracts";
import type { BoxRegistration } from "./boxes.js";

/**
 * Demo seed: a fictional site ("Kestrel Valley Camp") with three boxes and nine fictional volunteers. Names,
 * places and phone-free contacts are made up; nobody here is a real person.
 */

export const DEMO_SITE = { name: "Kestrel Valley Camp (fictional)", center: { lat: 40.35, lng: -74.66 } } as const;

export const DEMO_MANIFEST: Readonly<Record<string, number>> = {
  tourniquet: 2,
  gauze: 10,
  pressure_bandage: 6,
  gloves: 10,
  cpr_mask: 2,
  emergency_blanket: 2,
};

export const DEMO_BOXES: readonly BoxRegistration[] = [
  {
    box_id: "box-clinic",
    name: "Clinic tent",
    location: { lat: 40.35, lng: -74.66 },
    directions: "Clinic tent by the main gate. Inside the door, on the left wall under the red cross sign.",
    manifest: { ...DEMO_MANIFEST },
  },
  {
    box_id: "box-room-101",
    name: "Room 101",
    location: { lat: 40.3536, lng: -74.66 },
    directions: "School block, ground floor, Room 101. On the wall beside the whiteboard.",
    manifest: { ...DEMO_MANIFEST },
  },
  {
    box_id: "box-water-point",
    name: "Water point 3",
    location: { lat: 40.35, lng: -74.6411 },
    directions: "East road, water point 3. On the pump house wall facing the taps.",
    manifest: { ...DEMO_MANIFEST },
  },
];

const v = (volunteer: Volunteer): Volunteer => VolunteerSchema.parse(volunteer);

export const DEMO_VOLUNTEERS: readonly Volunteer[] = [
  v({ volunteer_id: "vol-amina", name: "Amina", skills: ["nurse", "first_aid"], languages: ["ar", "en"], vehicle_seats: 0, location: { lat: 40.352, lng: -74.659 }, available: true, channel: "whatsapp" }),
  v({ volunteer_id: "vol-yusuf", name: "Yusuf", skills: ["stop_the_bleed", "first_aid"], languages: ["fa", "en"], vehicle_seats: 0, location: { lat: 40.351, lng: -74.662 }, available: true, channel: "app" }),
  v({ volunteer_id: "vol-grace", name: "Grace", skills: ["doctor"], languages: ["en", "ig"], vehicle_seats: 0, location: { lat: 40.348, lng: -74.665 }, available: true, channel: "imessage" }),
  v({ volunteer_id: "vol-lena", name: "Lena", skills: ["cpr"], languages: ["de", "en"], vehicle_seats: 0, location: { lat: 40.346, lng: -74.656 }, available: true, channel: "sms" }),
  v({ volunteer_id: "vol-mei", name: "Mei", skills: ["midwife", "first_aid"], languages: ["zh", "en"], vehicle_seats: 0, location: { lat: 40.3555, lng: -74.668 }, available: true, channel: "app" }),
  v({ volunteer_id: "vol-tomas", name: "Tomas", skills: ["emt", "cpr", "driver"], languages: ["es", "en"], vehicle_seats: 3, location: { lat: 40.36, lng: -74.65 }, available: true, channel: "app" }),
  v({ volunteer_id: "vol-priya", name: "Priya", skills: ["nurse"], languages: ["hi", "en"], vehicle_seats: 2, location: { lat: 40.42, lng: -74.66 }, available: true, channel: "whatsapp" }),
  v({ volunteer_id: "vol-samir", name: "Samir", skills: ["driver"], languages: ["ar", "en"], vehicle_seats: 4, location: { lat: 40.353, lng: -74.657 }, available: true, channel: "app" }),
  v({ volunteer_id: "vol-daniel", name: "Daniel", skills: ["first_aid", "cpr"], languages: ["en", "tw"], vehicle_seats: 0, location: { lat: 40.3505, lng: -74.6605 }, available: false, channel: "app" }),
];

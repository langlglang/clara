import { afterEach, describe, expect, it, vi } from "vitest";
import { adminAuthorized } from "../lib/admin-auth";
import { GET as aerial } from "../app/api/admin/aerial/route";
import { GET as boxes } from "../app/api/admin/boxes/route";
import { GET as building } from "../app/api/admin/building/route";
import { GET as buildings } from "../app/api/admin/buildings/route";
import { POST as deploy } from "../app/api/admin/deploy/route";
import { GET as planGet, POST as planPost } from "../app/api/admin/plan/route";
import { GET as status } from "../app/api/admin/status/route";

afterEach(() => vi.unstubAllEnvs());

describe("Admin API credential", () => {
  it("rejects a missing configuration, a missing header, and a wrong token", () => {
    const req = (token?: string) => new Request("http://localhost/api/admin/status", { headers: token ? { "x-clara-admin-token": token } : {} });
    expect(adminAuthorized(req("secret"), undefined)).toBe(false);
    expect(adminAuthorized(req(), "secret")).toBe(false);
    expect(adminAuthorized(req("wrong"), "secret")).toBe(false);
    expect(adminAuthorized(req("secret"), "secret")).toBe(true);
  });

  it("gates every Admin read and mutation before loading data or parsing bodies", async () => {
    vi.stubEnv("CLARA_ADMIN_TOKEN", "a-long-separate-admin-token");
    const request = (url: string) => new Request(`http://localhost${url}`);
    const post = (url: string) => new Request(`http://localhost${url}`, { method: "POST", body: "not-json" });
    const responses = await Promise.all([
      aerial(request("/api/admin/aerial?id=1")),
      boxes(request("/api/admin/boxes")),
      building(request("/api/admin/building?id=1")),
      buildings(request("/api/admin/buildings")),
      deploy(post("/api/admin/deploy")),
      planGet(request("/api/admin/plan?id=1")),
      planPost(post("/api/admin/plan")),
      status(request("/api/admin/status")),
    ]);
    expect(responses.map((response) => response.status)).toEqual(Array(8).fill(403));
    expect((await responses[0]!.json()).error.code).toBe("forbidden");
  });
});

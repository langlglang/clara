import { describe, expect, it } from "vitest";
import { createCartesiaEars, createCartesiaVoice } from "../src/cartesia.js";
import { wav } from "./fixtures.js";

const signal = () => new AbortController().signal;

/** A fake fetch that records requests and answers from `respond`. */
function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { impl, calls };
}

describe("Cartesia ears", () => {
  it("sends the clip with ink-whisper and the session's language", async () => {
    const { impl, calls } = fakeFetch(() => Response.json({ text: "  it's bleeding  " }));
    const words = await createCartesiaEars({ apiKey: "k", fetchImpl: impl }).transcribe(wav, "ar-EG", signal());
    expect(words).toBe("it's bleeding");
    expect(calls[0]!.url).toBe("https://api.cartesia.ai/stt");
    const form = calls[0]!.init.body as FormData;
    expect(form.get("model")).toBe("ink-whisper");
    expect(form.get("language")).toBe("ar");
    expect((calls[0]!.init.headers as Record<string, string>)["cartesia-version"]).toBe("2026-08-14");
  });

  it("returns null on an HTTP error, a thrown fetch, bad JSON, or a non-WAV clip", async () => {
    const ears = (respond: () => Response) => createCartesiaEars({ apiKey: "k", fetchImpl: fakeFetch(respond).impl });
    expect(await ears(() => new Response("no", { status: 500 })).transcribe(wav, "en", signal())).toBeNull();
    expect(
      await ears(() => {
        throw new Error("offline");
      }).transcribe(wav, "en", signal()),
    ).toBeNull();
    expect(await ears(() => new Response("{oops")).transcribe(wav, "en", signal())).toBeNull();
    const { impl, calls } = fakeFetch(() => Response.json({ text: "x" }));
    expect(await createCartesiaEars({ apiKey: "k", fetchImpl: impl }).transcribe(Buffer.from("not a wav"), "en", signal())).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("Cartesia voice", () => {
  it("asks Sonic for a WAV in the session's language and returns it", async () => {
    const { impl, calls } = fakeFetch(() => new Response(new Uint8Array(wav)));
    const audio = await createCartesiaVoice({ apiKey: "k", fetchImpl: impl }).speak("Tell me more.", "es", signal());
    expect(audio?.equals(wav)).toBe(true);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({ model_id: "sonic-3.6", transcript: "Tell me more.", language: "es", output_format: { container: "wav", sample_rate: 16_000 } });
  });

  it("returns null for non-WAV bytes, oversized audio, or an error", async () => {
    const voice = (respond: () => Response) => createCartesiaVoice({ apiKey: "k", fetchImpl: fakeFetch(respond).impl });
    expect(await voice(() => new Response("hello")).speak("x", "en", signal())).toBeNull();
    expect(await voice(() => new Response(new Uint8Array(wav), { headers: { "content-length": "9999999" } })).speak("x", "en", signal())).toBeNull();
    expect(await voice(() => new Response(new Uint8Array(3_000_000))).speak("x", "en", signal())).toBeNull();
    expect(await voice(() => new Response("", { status: 429 })).speak("x", "en", signal())).toBeNull();
  });
});

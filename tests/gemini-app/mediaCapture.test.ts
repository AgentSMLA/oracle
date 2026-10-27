import { afterEach, describe, expect, it, vi } from "vitest";
import { captureGeminiMedia, mediaCaptureSchema } from "../../src/gemini-app/dom.js";

afterEach(() => vi.unstubAllGlobals());

describe("proven in-page media capture paths", () => {
  it("draws already decoded generated pixels into a PNG canvas at their observed dimensions", async () => {
    // Given
    class Image {
      complete = true;
      naturalWidth = 1024;
      naturalHeight = 572;
    }
    const image = new Image();
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toDataURL: () => "data:image/png;base64,iVBORw0KGgo=",
    };
    vi.stubGlobal("HTMLImageElement", Image);
    vi.stubGlobal("document", { querySelector: () => image, createElement: () => canvas });
    // When
    const capture = mediaCaptureSchema.parse(
      await captureGeminiMedia({ kind: "capture-image", selector: "#fresh-image" }, 1_000),
    );
    // Then
    expect(capture).toMatchObject({ mimeType: "image/png", width: 1024, height: 572 });
    expect(canvas.width).toBe(1024);
    expect(canvas.height).toBe(572);
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(image, 0, 0);
  });

  it("rejects undecoded pixels rather than clicking or fetching a revoked image blob", async () => {
    // Given
    class Image {
      complete = false;
      naturalWidth = 0;
      naturalHeight = 0;
    }
    vi.stubGlobal("HTMLImageElement", Image);
    vi.stubGlobal("document", { querySelector: () => new Image() });
    // When / Then
    await expect(
      captureGeminiMedia({ kind: "capture-image", selector: "#fresh-image" }, 1_000),
    ).rejects.toThrow();
  });

  it.each(["video", "music"] as const)(
    "uses same-page authenticated fetch and FileReader for %s bytes",
    async (mode) => {
      // Given
      class Video {
        currentSrc = "https://example.test/generated-video";
      }
      class Reader {
        result: string | null = null;
        error: DOMException | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onabort: (() => void) | null = null;
        readAsDataURL(blob: Blob): void {
          void blob.arrayBuffer().then((bytes) => {
            this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
            this.onload?.();
          });
        }
        abort(): void {
          this.onabort?.();
        }
      }
      const bytes = Buffer.from("VIDEO_BYTE_SENTINEL");
      const fetchPage = vi.fn(
        async () =>
          new Response(bytes, {
            headers: { "content-type": mode === "video" ? "video/mp4" : "audio/mpeg" },
          }),
      );
      vi.stubGlobal("HTMLVideoElement", Video);
      vi.stubGlobal("HTMLAudioElement", Video);
      vi.stubGlobal("FileReader", Reader);
      vi.stubGlobal("document", { querySelector: () => new Video() });
      vi.stubGlobal("fetch", fetchPage);
      // When
      const capture = mediaCaptureSchema.parse(
        await captureGeminiMedia(
          { kind: mode === "video" ? "capture-video" : "capture-music", selector: "#fresh-video" },
          1_000,
        ),
      );
      // Then
      expect(fetchPage).toHaveBeenCalledWith(
        "https://example.test/generated-video",
        expect.objectContaining({ credentials: "include", signal: expect.any(AbortSignal) }),
      );
      expect(capture.byteLength).toBe(bytes.length);
      expect(Buffer.from(capture.dataUrl.split(",")[1] ?? "", "base64")).toEqual(bytes);
    },
  );

  it("rejects a login HTML response rather than exporting it as video", async () => {
    // Given
    class Video {
      currentSrc = "https://example.test/generated-video";
    }
    vi.stubGlobal("HTMLVideoElement", Video);
    vi.stubGlobal("document", { querySelector: () => new Video() });
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("<html>LOGIN_SENTINEL</html>", { headers: { "content-type": "text/html" } }),
    );
    // When / Then
    await expect(
      captureGeminiMedia({ kind: "capture-video", selector: "#fresh-video" }, 1_000),
    ).rejects.toThrow();
  });
});

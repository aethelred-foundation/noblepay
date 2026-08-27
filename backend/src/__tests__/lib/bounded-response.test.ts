import {
  ExternalResponseTooLargeError,
  readBoundedJsonResponse,
  readBoundedResponseText,
} from "../../lib/bounded-response";

describe("bounded external responses", () => {
  it("parses JSON while the decoded body remains within the cap", async () => {
    const response = new Response(JSON.stringify({ ok: true }));
    await expect(readBoundedJsonResponse(response, 64)).resolves.toEqual({
      ok: true,
    });
  });

  it("rejects an oversized declared Content-Length before buffering the body", async () => {
    const response = new Response("small", {
      headers: { "Content-Length": "1000" },
    });
    await expect(readBoundedResponseText(response, 32)).rejects.toBeInstanceOf(
      ExternalResponseTooLargeError,
    );
  });

  it("cancels a streamed response as soon as decoded bytes exceed the cap", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345678901"));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readBoundedResponseText(new Response(stream), 10),
    ).rejects.toBeInstanceOf(ExternalResponseTooLargeError);
    expect(cancelled).toBe(true);
  });
});

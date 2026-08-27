import { fireEvent, render, screen } from "@testing-library/react";
import { NetworkAnchorGate } from "@/components/NetworkAnchorGate";

const EXPECTED_HASH = `0x${"ab".repeat(32)}`;
const OTHER_HASH = `0x${"cd".repeat(32)}`;

describe("NetworkAnchorGate", () => {
  const wagmi = require("wagmi");
  const originalPublicClient = wagmi.usePublicClient;

  afterEach(() => {
    wagmi.usePublicClient = originalPublicClient;
  });

  it("keeps application reads unmounted until the public RPC proves the anchor", async () => {
    const request = jest
      .fn()
      .mockResolvedValue({ number: "0x1", hash: EXPECTED_HASH });
    const publicClient = { request };
    wagmi.usePublicClient = () => publicClient;

    render(
      <NetworkAnchorGate>
        <div>protected application data</div>
      </NetworkAnchorGate>,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Verifying Aethelred network identity",
    );
    expect(screen.queryByText("protected application data")).toBeNull();
    expect(
      await screen.findByText("protected application data"),
    ).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith({
      method: "eth_getBlockByNumber",
      params: ["0x1", false],
    });
  });

  it("fails closed and does not render application reads on an anchor mismatch", async () => {
    const publicClient = {
      request: jest.fn().mockResolvedValue({ number: "0x1", hash: OTHER_HASH }),
    };
    wagmi.usePublicClient = () => publicClient;

    render(
      <NetworkAnchorGate>
        <div>protected application data</div>
      </NetworkAnchorGate>,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Network verification failed",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("protected application data")).toBeNull();
  });

  it("rechecks the public RPC before admitting reads after retry", async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({ number: "0x1", hash: OTHER_HASH })
      .mockResolvedValueOnce({ number: "0x1", hash: EXPECTED_HASH });
    const publicClient = { request };
    wagmi.usePublicClient = () => publicClient;

    render(
      <NetworkAnchorGate>
        <div>protected application data</div>
      </NetworkAnchorGate>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Retry verification" }),
    );
    expect(
      await screen.findByText("protected application data"),
    ).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
  });
});

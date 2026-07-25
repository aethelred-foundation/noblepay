import { act, renderHook } from "@testing-library/react";
import { useSafeWriteContract } from "@/hooks/useSafeWriteContract";

const HASH = `0x${"ab".repeat(32)}`;
const params = {
  address: "0x1111111111111111111111111111111111111111" as const,
  abi: [] as const,
  functionName: "pay",
};

describe("useSafeWriteContract network anchor", () => {
  const wagmi = require("wagmi");
  const originalAccount = wagmi.useAccount;
  const originalPublicClient = wagmi.usePublicClient;
  const originalWrite = wagmi.useWriteContract;

  afterEach(() => {
    wagmi.useAccount = originalAccount;
    wagmi.usePublicClient = originalPublicClient;
    wagmi.useWriteContract = originalWrite;
  });

  function configure(hash = HASH) {
    const order: string[] = [];
    const request = jest.fn().mockImplementation(async () => {
      order.push("wallet-anchor");
      return { number: "0x1", hash };
    });
    const rawWriteAsync = jest.fn().mockImplementation(async () => {
      order.push("wallet-send");
      return `0x${"1".repeat(64)}`;
    });
    wagmi.useAccount = () => ({
      address: "0x1234567890abcdef1234567890abcdef12345678",
      connector: { getProvider: jest.fn().mockResolvedValue({ request }) },
    });
    wagmi.usePublicClient = () => ({
      request: jest.fn().mockImplementation(async () => {
        order.push("public-anchor");
        return { number: "0x1", hash: HASH };
      }),
      estimateContractGas: jest.fn().mockImplementation(async () => {
        order.push("public-estimate");
        return 100_000n;
      }),
    });
    wagmi.useWriteContract = () => ({
      writeContract: jest.fn(),
      writeContractAsync: rawWriteAsync,
      reset: jest.fn(),
      error: null,
      isError: false,
    });
    return { order, request, rawWriteAsync };
  }

  it("checks the wallet provider after estimation and immediately before send", async () => {
    const configured = configure();
    const { result } = renderHook(() => useSafeWriteContract());
    await act(async () => {
      await result.current.writeContractAsync(params);
    });
    expect(configured.order).toEqual([
      "public-anchor",
      "public-estimate",
      "wallet-anchor",
      "wallet-send",
    ]);
    expect(configured.request).toHaveBeenCalledWith({
      method: "eth_getBlockByNumber",
      params: ["0x1", false],
    });
  });

  it("does not invoke the signing/send mutation when the wallet anchor differs", async () => {
    const configured = configure(`0x${"cd".repeat(32)}`);
    const { result } = renderHook(() => useSafeWriteContract());
    await act(async () => {
      await expect(result.current.writeContractAsync(params)).rejects.toThrow(
        /does not match/u,
      );
    });
    expect(configured.rawWriteAsync).not.toHaveBeenCalled();
    expect(configured.order).toEqual([
      "public-anchor",
      "public-estimate",
      "wallet-anchor",
    ]);
  });

  it("does not estimate or prompt when the configured public RPC anchor differs", async () => {
    const configured = configure();
    wagmi.usePublicClient = () => ({
      request: jest.fn().mockResolvedValue({
        number: "0x1",
        hash: `0x${"cd".repeat(32)}`,
      }),
      estimateContractGas: jest.fn(),
    });
    const { result } = renderHook(() => useSafeWriteContract());
    await act(async () => {
      await expect(result.current.writeContractAsync(params)).rejects.toThrow(
        /configured public RPC network does not match/u,
      );
    });
    expect(configured.request).not.toHaveBeenCalled();
    expect(configured.rawWriteAsync).not.toHaveBeenCalled();
  });
});

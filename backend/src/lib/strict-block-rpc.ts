import { JsonRpcProvider, toQuantity } from "ethers";

/** Issue eth_call without ethers' block-tag retry/fallback behavior. */
export async function strictBlockCall(
  provider: JsonRpcProvider,
  request: { to: string; data: string },
  blockNumber: number,
): Promise<string> {
  const result = await provider.send("eth_call", [
    request,
    toQuantity(blockNumber),
  ]);
  if (typeof result !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(result)) {
    throw new Error("RPC returned an invalid eth_call result");
  }
  return result;
}

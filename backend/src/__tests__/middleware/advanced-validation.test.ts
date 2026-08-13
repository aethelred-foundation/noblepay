import {
  AddLiquiditySchema,
  AdvancedPaginationSchema,
  CreateCrossChainTransferSchema,
  CreateFXHedgeSchema,
  CreateStreamSchema,
  CreateTreasuryProposalSchema,
  CrossChainRouteQuerySchema,
  FlaggedPaymentsQuerySchema,
  LiquidityPoolsQuerySchema,
  StreamListQuerySchema,
  TreasuryProposalListQuerySchema,
} from "../../middleware/validation";

const address = "0x1111111111111111111111111111111111111111";
const secondAddress = "0x2222222222222222222222222222222222222222";

describe("advanced route validation", () => {
  it("strictly validates liquidity ranges, decimals, and pagination", () => {
    // Adding liquidity now reports an on-chain settlement, so every valid
    // body carries one. Spread into each case so the assertions stay about
    // ranges and decimals rather than about the settlement fields.
    const settlement = {
      txHash:
        "0xc62faafeb160571853128e25efc65388ca483c22504742b7b455dfcc8ade5faa",
      onChainPositionId:
        "0xb0e5549ef29f19213987c37c736b4955892f71e833ef1379f5306e02a77ebe6e",
    };
    expect(
      AddLiquiditySchema.safeParse({
        ...settlement,
        amountA: "1.25",
        amountB: "2",
      }).success,
    ).toBe(true);
    expect(
      AddLiquiditySchema.safeParse({
        ...settlement,
        amountA: "1e9",
        amountB: "2",
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      AddLiquiditySchema.safeParse({
        ...settlement,
        amountA: "1",
        amountB: "2",
        rangeMin: 10,
        rangeMax: 10,
      }).success,
    ).toBe(false);
    // A settlement-free body is now rejected outright: liquidity cannot be
    // recorded without naming the transaction that moved it.
    expect(
      AddLiquiditySchema.safeParse({ amountA: "1.25", amountB: "2" }).success,
    ).toBe(false);
    expect(LiquidityPoolsQuerySchema.safeParse({ limit: "101" }).success).toBe(
      false,
    );
  });

  it("strictly validates stream identities, chronology, enums, and metadata", () => {
    const valid = {
      sender: address,
      recipient: secondAddress,
      totalAmount: "10.5",
      currency: "USDC",
      startTime: "2026-07-21T10:00:00.000Z",
      endTime: "2026-07-22T10:00:00.000Z",
    };
    expect(CreateStreamSchema.safeParse(valid).success).toBe(true);
    expect(
      CreateStreamSchema.safeParse({ ...valid, recipient: address }).success,
    ).toBe(false);
    expect(
      CreateStreamSchema.safeParse({ ...valid, endTime: valid.startTime })
        .success,
    ).toBe(false);
    expect(StreamListQuerySchema.safeParse({ status: "FAKE" }).success).toBe(
      false,
    );
  });

  it("strictly validates FX pairs, base currency, expiry, and unknown keys", () => {
    const valid = {
      pair: "USDC/AED",
      type: "FORWARD",
      notionalAmount: "1000",
      currency: "USDC",
      expiryDate: new Date(Date.now() + 86_400_000).toISOString(),
      marginDeposit: "100",
      // A hedge record without a receipt is an unverifiable claim that a
      // position exists, so these are required.
      txHash: `0x${"c".repeat(64)}`,
      onChainPositionId: `0x${"d".repeat(64)}`,
      onChainHedgeType: "FORWARD",
    };
    expect(CreateFXHedgeSchema.safeParse(valid).success).toBe(true);
    expect(
      CreateFXHedgeSchema.safeParse({ ...valid, currency: "USDT" }).success,
    ).toBe(false);
    expect(
      CreateFXHedgeSchema.safeParse({ ...valid, fakeRate: 3.67 }).success,
    ).toBe(false);

    // No receipt, no record.
    const { txHash: _t, ...noReceipt } = valid;
    expect(CreateFXHedgeSchema.safeParse(noReceipt).success).toBe(false);

    // FXHedgingVault cannot create a SWAP, so one can never be verified.
    expect(
      CreateFXHedgeSchema.safeParse({ ...valid, type: "SWAP" }).success,
    ).toBe(false);

    // A forward is not an option, in either direction.
    expect(
      CreateFXHedgeSchema.safeParse({
        ...valid,
        onChainHedgeType: "OPTION_CALL",
      }).success,
    ).toBe(false);
    expect(
      CreateFXHedgeSchema.safeParse({
        ...valid,
        type: "OPTION",
        onChainHedgeType: "FORWARD",
      }).success,
    ).toBe(false);

    // An option may be either direction.
    for (const onChainHedgeType of ["OPTION_CALL", "OPTION_PUT"]) {
      expect(
        CreateFXHedgeSchema.safeParse({
          ...valid,
          type: "OPTION",
          onChainHedgeType,
        }).success,
      ).toBe(true);
    }
  });

  it("strictly validates cross-chain routes and transfer addresses", () => {
    expect(
      CrossChainRouteQuerySchema.safeParse({
        source: "aethelred",
        destination: "ethereum",
        token: "USDC",
        amount: "12.5",
      }).success,
    ).toBe(true);
    expect(
      CrossChainRouteQuerySchema.safeParse({
        source: "aethelred",
        destination: "aethelred",
        token: "USDC",
        amount: "12.5",
      }).success,
    ).toBe(false);
    expect(
      CreateCrossChainTransferSchema.safeParse({
        sourceChain: "aethelred",
        destinationChain: "ethereum",
        token: "USDC",
        amount: "5",
        recipient: "not-an-address",
      }).success,
    ).toBe(false);
  });

  it("strictly validates policy-backed treasury proposals and list bounds", () => {
    const valid = {
      title: "Supplier payment",
      description: "Pay a verified infrastructure supplier",
      type: "TRANSFER",
      amount: "500",
      currency: "USDC",
      recipient: secondAddress,
      category: "INFRASTRUCTURE",
    };
    expect(CreateTreasuryProposalSchema.safeParse(valid).success).toBe(true);
    expect(
      CreateTreasuryProposalSchema.safeParse({ ...valid, category: undefined })
        .success,
    ).toBe(false);
    expect(
      TreasuryProposalListQuerySchema.safeParse({ status: "UNKNOWN" }).success,
    ).toBe(false);
    expect(AdvancedPaginationSchema.parse({})).toEqual({ page: 1, limit: 50 });
  });

  it("bounds the tenant flagged-payment queue", () => {
    expect(FlaggedPaymentsQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 20,
    });
    expect(FlaggedPaymentsQuerySchema.safeParse({ page: "0" }).success).toBe(
      false,
    );
    expect(FlaggedPaymentsQuerySchema.safeParse({ limit: "101" }).success).toBe(
      false,
    );
    expect(
      FlaggedPaymentsQuerySchema.safeParse({ limit: "1000000" }).success,
    ).toBe(false);
    expect(
      FlaggedPaymentsQuerySchema.safeParse({
        page: "1",
        limit: "50",
        extra: "x",
      }).success,
    ).toBe(false);
  });
});

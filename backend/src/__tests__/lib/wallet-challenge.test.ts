import {
  buildRegistrationCommitment,
  buildWalletChallengeMessage,
  isRegistrationChallengeBound,
  isWalletChallengeBound,
  resolveWalletRelyingParty,
} from "../../lib/wallet-challenge";

describe("wallet challenge relying-party binding", () => {
  const relyingParty = {
    origin: "https://pay.aethelred.network",
    domain: "pay.aethelred.network",
    chainId: "7332",
  };
  const registration = {
    address: "0x1111111111111111111111111111111111111111",
    txHash: `0x${"ab".repeat(32)}`,
    licenseNumber: "DMCC123456",
    businessName: "Acme Treasury",
    jurisdiction: "UAE",
    businessType: "LLC",
    complianceOfficer: "0x2222222222222222222222222222222222222222",
    contactEmail: "ops@acme.test",
  };

  it("builds an exact EIP-4361-style domain, URI, chain and request binding", () => {
    const registrationCommitment = buildRegistrationCommitment(registration);
    const message = buildWalletChallengeMessage({
      address: registration.address,
      purpose: "registration",
      nonce: "0123456789abcdef0123456789abcdef",
      issuedAt: new Date("2026-07-21T10:00:00.000Z"),
      expiresAt: new Date("2026-07-21T10:05:00.000Z"),
      challengeId: "11111111-1111-4111-8111-111111111111",
      txHash: registration.txHash,
      registrationCommitment,
      relyingParty,
    });
    expect(message).toContain("pay.aethelred.network wants you to sign in");
    expect(message).toContain("URI: https://pay.aethelred.network");
    expect(message).toContain("Chain ID: 7332");
    expect(message).toContain(
      "Request ID: 11111111-1111-4111-8111-111111111111",
    );
    expect(message).toContain(`urn:noblepay:transaction:0x${"ab".repeat(32)}`);
    expect(message).toContain(
      `urn:noblepay:registration-commitment:${registrationCommitment}`,
    );
    expect(isWalletChallengeBound(message, relyingParty)).toBe(true);
    expect(
      isRegistrationChallengeBound(message, {
        txHash: registration.txHash,
        registrationCommitment,
      }),
    ).toBe(true);
    expect(
      isWalletChallengeBound(message, { ...relyingParty, chainId: "1" }),
    ).toBe(false);
    expect(
      isWalletChallengeBound(message, {
        ...relyingParty,
        origin: "https://evil.example",
      }),
    ).toBe(false);
  });

  it("uses collision-safe canonical encoding for the complete registration profile", () => {
    const commitment = buildRegistrationCommitment(registration);
    expect(commitment).toMatch(/^0x[a-f0-9]{64}$/);
    expect(
      buildRegistrationCommitment({
        ...registration,
        address: registration.address.toUpperCase().replace("0X", "0x"),
        txHash: registration.txHash.toUpperCase().replace("0X", "0x"),
        jurisdiction: " uae ",
        licenseNumber: ` ${registration.licenseNumber} `,
        businessName: ` ${registration.businessName} `,
        businessType: " LLC ",
        contactEmail: " OPS@ACME.TEST ",
      }),
    ).toBe(commitment);

    for (const altered of [
      { licenseNumber: "DMCC123457" },
      { businessName: "Acme Treasur" },
      { jurisdiction: "INTERNATIONAL" },
      { businessType: "PLC" },
      { complianceOfficer: "0x3333333333333333333333333333333333333333" },
      { contactEmail: "security@acme.test" },
      { txHash: `0x${"ac".repeat(32)}` },
    ]) {
      expect(
        buildRegistrationCommitment({ ...registration, ...altered }),
      ).not.toBe(commitment);
    }
  });

  it("rejects ambiguous, altered, or incomplete registration resource bindings", () => {
    const commitment = buildRegistrationCommitment(registration);
    const message = buildWalletChallengeMessage({
      address: registration.address,
      purpose: "registration",
      nonce: "0123456789abcdef0123456789abcdef",
      issuedAt: new Date("2026-07-21T10:00:00.000Z"),
      expiresAt: new Date("2026-07-21T10:05:00.000Z"),
      challengeId: "11111111-1111-4111-8111-111111111111",
      txHash: registration.txHash,
      registrationCommitment: commitment,
      relyingParty,
    });
    expect(
      isRegistrationChallengeBound(
        message.replace(commitment, `0x${"00".repeat(32)}`),
        {
          txHash: registration.txHash,
          registrationCommitment: commitment,
        },
      ),
    ).toBe(false);
    expect(
      isRegistrationChallengeBound(
        `${message}\n- urn:noblepay:registration-commitment:${commitment}`,
        {
          txHash: registration.txHash,
          registrationCommitment: commitment,
        },
      ),
    ).toBe(false);
    expect(
      isRegistrationChallengeBound(
        message.replace(
          "- urn:noblepay:purpose:registration",
          "- urn:noblepay:purpose:authentication",
        ),
        {
          txHash: registration.txHash,
          registrationCommitment: commitment,
        },
      ),
    ).toBe(false);
    expect(() =>
      buildWalletChallengeMessage({
        address: registration.address,
        purpose: "registration",
        nonce: "nonce",
        issuedAt: new Date(),
        expiresAt: new Date(),
        challengeId: "id",
        txHash: registration.txHash,
        relyingParty,
      }),
    ).toThrow(/profile commitment/);
  });

  it("resolves only exact origins and positive chain IDs", () => {
    expect(
      resolveWalletRelyingParty({
        PUBLIC_ORIGIN: "https://pay.aethelred.network",
        NOBLEPAY_CHAIN_ID: "7332",
      } as NodeJS.ProcessEnv),
    ).toEqual(relyingParty);
    expect(() =>
      resolveWalletRelyingParty({
        PUBLIC_ORIGIN: "https://pay.aethelred.network/path",
        NOBLEPAY_CHAIN_ID: "7332",
      } as NodeJS.ProcessEnv),
    ).toThrow(/origin/);
    expect(() =>
      resolveWalletRelyingParty({
        PUBLIC_ORIGIN: "https://pay.aethelred.network",
        NOBLEPAY_CHAIN_ID: "0",
      } as NodeJS.ProcessEnv),
    ).toThrow(/positive integer/);
  });
});

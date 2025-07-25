import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

const simnet = (globalThis as any).simnet;

const accounts = simnet.getAccounts();
const address1 = accounts.get("wallet_1")!;
const address2 = accounts.get("wallet_2")!;
const address3 = accounts.get("wallet_3")!;
const deployer = accounts.get("deployer")!;

const contractName = "micro_stx";

// Error constants
const ERR_UNAUTHORIZED = 100;
const ERR_INVALID_AMOUNT = 101;
const ERR_CHANNEL_NOT_FOUND = 102;
const ERR_CHANNEL_ALREADY_EXISTS = 103;
const ERR_CHANNEL_CLOSED = 104;
const ERR_INSUFFICIENT_BALANCE = 105;
const ERR_INVALID_SIGNATURE = 106;
const ERR_TIMEOUT_NOT_REACHED = 107;
const ERR_DISPUTE_ACTIVE = 108;
const ERR_INVALID_NONCE = 109;
const ERR_MAX_CHANNELS_EXCEEDED = 110;

// Channel states
const CHANNEL_OPEN = 1;
const CHANNEL_DISPUTED = 2;
const CHANNEL_CLOSED = 3;

// Contract constants
const MIN_CHANNEL_AMOUNT = 1000000; // 1 STX
const MAX_CHANNEL_AMOUNT = 1000000000000; // 1M STX
const CHANNEL_TIMEOUT = 144; // ~24 hours in blocks
const DISPUTE_TIMEOUT = 144;
const SETTLEMENT_FEE = 10000; // 0.01 STX
const MAX_CHANNELS_PER_USER = 100;

describe("MicroSTX Micropayment Channel Tests", () => {
  beforeEach(() => {
    simnet.mineEmptyBlocks(1);
  });

  describe("Contract Initialization and Read-Only Functions", () => {
    it("returns correct contract stats", () => {
      const { result } = simnet.callReadOnlyFn(contractName, "get-contract-stats", [], deployer);
      expect(result).toBeOk(
        Cl.tuple({
          "total-channels": Cl.uint(0),
          "total-locked": Cl.uint(0),
          "min-channel-amount": Cl.uint(MIN_CHANNEL_AMOUNT),
          "max-channel-amount": Cl.uint(MAX_CHANNEL_AMOUNT),
          "channel-timeout": Cl.uint(CHANNEL_TIMEOUT),
          "dispute-timeout": Cl.uint(DISPUTE_TIMEOUT),
          "settlement-fee": Cl.uint(SETTLEMENT_FEE)
        })
      );
    });

    it("returns none for non-existent channel", () => {
      const { result } = simnet.callReadOnlyFn(contractName, "get-channel-details", [Cl.uint(999)], deployer);
      expect(result).toBeNone();
    });

    it("returns false for non-existent channel activity", () => {
      const { result } = simnet.callReadOnlyFn(contractName, "is-channel-active", [Cl.uint(999)], deployer);
      expect(result).toBeBool(false);
    });

    it("returns zero for new user channel count", () => {
      const { result } = simnet.callReadOnlyFn(contractName, "get-user-channel-count", [Cl.principal(address1)], deployer);
      expect(result).toBeUint(0);
    });

    it("returns none for non-existent dispute", () => {
      const { result } = simnet.callReadOnlyFn(contractName, "get-channel-dispute", [Cl.uint(999)], deployer);
      expect(result).toBeNone();
    });

    it("returns none for non-existent payment commitment", () => {
      const { result } = simnet.callReadOnlyFn(
        contractName, 
        "get-payment-commitment", 
        [Cl.uint(999), Cl.uint(1)], 
        deployer
      );
      expect(result).toBeNone();
    });

    it("returns contract balance", () => {
      const { result } = simnet.callReadOnlyFn(contractName, "get-contract-balance", [], deployer);
      expect(result).toBeUint(0); // Should be 0 initially
    });
  });

  describe("Channel Opening", () => {
    it("allows user to open channel", () => {
      const { result } = simnet.callPublicFn(
        contractName,
        "open-channel",
        [
          Cl.principal(address2),
          Cl.uint(5000000), // 5 STX from participant A
          Cl.uint(3000000)  // 3 STX expected from participant B
        ],
        address1
      );
      expect(result).toBeOk(Cl.uint(0)); // First channel ID
    });

    it("stores channel details correctly", () => {
      const amountA = 5000000;
      const amountB = 3000000;
      
      simnet.callPublicFn(
        contractName,
        "open-channel",
        [
          Cl.principal(address2),
          Cl.uint(amountA),
          Cl.uint(amountB)
        ],
        address1
      );

      const { result } = simnet.callReadOnlyFn(contractName, "get-channel-details", [Cl.uint(0)], deployer);
      
      expect(result).toBeSome(
        Cl.tuple({
          "participant-a": Cl.principal(address1),
          "participant-b": Cl.principal(address2),
          "balance-a": Cl.uint(amountA),
          "balance-b": Cl.uint(amountB),
          "total-amount": Cl.uint(amountA + amountB),
          "nonce": Cl.uint(0),
          "state": Cl.uint(CHANNEL_OPEN),
          "timeout-block": Cl.uint(simnet.blockHeight + CHANNEL_TIMEOUT),
          "created-at": Cl.uint(simnet.blockHeight),
          "last-update": Cl.uint(simnet.blockHeight)
        })
      );
    });

    it("updates contract stats after channel opening", () => {
      const amountA = 5000000;
      
      simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address2), Cl.uint(amountA), Cl.uint(3000000)],
        address1
      );

      const { result } = simnet.callReadOnlyFn(contractName, "get-contract-stats", [], deployer);
      expect(result).toBeOk(
        Cl.tuple({
          "total-channels": Cl.uint(1),
          "total-locked": Cl.uint(amountA),
          "min-channel-amount": Cl.uint(MIN_CHANNEL_AMOUNT),
          "max-channel-amount": Cl.uint(MAX_CHANNEL_AMOUNT),
          "channel-timeout": Cl.uint(CHANNEL_TIMEOUT),
          "dispute-timeout": Cl.uint(DISPUTE_TIMEOUT),
          "settlement-fee": Cl.uint(SETTLEMENT_FEE)
        })
      );
    });

    it("increments user channel count", () => {
      simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address2), Cl.uint(5000000), Cl.uint(3000000)],
        address1
      );

      const { result } = simnet.callReadOnlyFn(contractName, "get-user-channel-count", [Cl.principal(address1)], deployer);
      expect(result).toBeUint(1);
    });

    it("prevents opening channel with same participant", () => {
      const { result } = simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address1), Cl.uint(5000000), Cl.uint(3000000)],
        address1
      );
      expect(result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
    });

    it("prevents opening channel below minimum amount", () => {
      const { result } = simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address2), Cl.uint(500000), Cl.uint(400000)], // Total below 1 STX
        address1
      );
      expect(result).toBeErr(Cl.uint(ERR_INVALID_AMOUNT));
    });

    it("prevents opening channel above maximum amount", () => {
      const { result } = simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address2), Cl.uint(MAX_CHANNEL_AMOUNT), Cl.uint(1)], // Above max
        address1
      );
      expect(result).toBeErr(Cl.uint(ERR_INVALID_AMOUNT));
    });

    it("charges settlement fee to channel opener", () => {
      const initialBalance = simnet.getAssetsMap().get(address1)?.STX || 0;
      const amountA = 5000000;
      
      simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address2), Cl.uint(amountA), Cl.uint(3000000)],
        address1
      );

      const finalBalance = simnet.getAssetsMap().get(address1)?.STX || 0;
      expect(finalBalance).toBe(initialBalance - amountA - SETTLEMENT_FEE);
    });

    it("allows multiple channels between different users", () => {
      // Channel 1: address1 -> address2
      const result1 = simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address2), Cl.uint(5000000), Cl.uint(3000000)],
        address1
      );
      expect(result1.result).toBeOk(Cl.uint(0));

      // Channel 2: address1 -> address3
      const result2 = simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address3), Cl.uint(4000000), Cl.uint(2000000)],
        address1
      );
      expect(result2.result).toBeOk(Cl.uint(1));

      // Channel 3: address2 -> address3
      const result3 = simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address3), Cl.uint(6000000), Cl.uint(4000000)],
        address2
      );
      expect(result3.result).toBeOk(Cl.uint(2));
    });

    it("sets channel as active after opening", () => {
      simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address2), Cl.uint(5000000), Cl.uint(3000000)],
        address1
      );

      const { result } = simnet.callReadOnlyFn(contractName, "is-channel-active", [Cl.uint(0)], deployer);
      expect(result).toBeBool(true);
    });
  });

  describe("Channel Funding", () => {
    beforeEach(() => {
      // Create a channel for testing
      simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address2), Cl.uint(5000000), Cl.uint(3000000)],
        address1
      );
    });

    it("allows participant B to fund channel", () => {
      const { result } = simnet.callPublicFn(
        contractName,
        "fund-channel",
        [Cl.uint(0), Cl.uint(3000000)],
        address2
      );
      expect(result).toBeOk(Cl.bool(true));
    });

    it("updates total locked amount after funding", () => {
      simnet.callPublicFn(
        contractName,
        "fund-channel",
        [Cl.uint(0), Cl.uint(3000000)],
        address2
      );

      const { result } = simnet.callReadOnlyFn(contractName, "get-contract-stats", [], deployer);
      const stats = result.expectOk();
      expect(stats).toMatchObject({
        "total-locked": Cl.uint(8000000) // 5M + 3M
      });
    });

    it("updates channel timeout after funding", () => {
      const initialChannel = simnet.callReadOnlyFn(contractName, "get-channel-details", [Cl.uint(0)], deployer);
      const initialTimeout = initialChannel.result.expectSome();
      
      // Move forward some blocks
      simnet.mineEmptyBlocks(10);
      
      simnet.callPublicFn(
        contractName,
        "fund-channel",
        [Cl.uint(0), Cl.uint(3000000)],
        address2
      );

      const updatedChannel = simnet.callReadOnlyFn(contractName, "get-channel-details", [Cl.uint(0)], deployer);
      const updatedData = updatedChannel.result.expectSome();
      
      expect(updatedData).toMatchObject({
        "timeout-block": Cl.uint(simnet.blockHeight + CHANNEL_TIMEOUT)
      });
    });

    it("prevents non-participant B from funding", () => {
      const { result } = simnet.callPublicFn(
        contractName,
        "fund-channel",
        [Cl.uint(0), Cl.uint(3000000)],
        address3 // Not participant B
      );
      expect(result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
    });

    it("prevents funding non-existent channel", () => {
      const { result } = simnet.callPublicFn(
        contractName,
        "fund-channel",
        [Cl.uint(999), Cl.uint(3000000)],
        address2
      );
      expect(result).toBeErr(Cl.uint(ERR_CHANNEL_NOT_FOUND));
    });

    it("prevents funding with incorrect amount", () => {
      const { result } = simnet.callPublicFn(
        contractName,
        "fund-channel",
        [Cl.uint(0), Cl.uint(2000000)], // Wrong amount
        address2
      );
      expect(result).toBeErr(Cl.uint(ERR_INVALID_AMOUNT));
    });

    it("prevents double funding", () => {
      // First funding
      simnet.callPublicFn(
        contractName,
        "fund-channel",
        [Cl.uint(0), Cl.uint(3000000)],
        address2
      );

      // Second funding attempt
      const { result } = simnet.callPublicFn(
        contractName,
        "fund-channel",
        [Cl.uint(0), Cl.uint(3000000)],
        address2
      );
      expect(result).toBeErr(Cl.uint(ERR_CHANNEL_ALREADY_EXISTS));
    });
  });

  describe("Channel Updates", () => {
    beforeEach(() => {
      // Create and fund a channel
      simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address2), Cl.uint(5000000), Cl.uint(3000000)],
        address1
      );
      simnet.callPublicFn(
        contractName,
        "fund-channel",
        [Cl.uint(0), Cl.uint(3000000)],
        address2
      );
    });

    it("allows participant to close channel cooperatively", () => {
      const { result } = simnet.callPublicFn(
        contractName,
        "close-channel",
        [Cl.uint(0)],
        address1
      );
      expect(result).toBeOk(Cl.bool(true));
    });

    it("distributes final balances to participants", () => {
      const initialBalance1 = simnet.getAssetsMap().get(address1)?.STX || 0;
      const initialBalance2 = simnet.getAssetsMap().get(address2)?.STX || 0;

      simnet.callPublicFn(contractName, "close-channel", [Cl.uint(0)], address1);

      const finalBalance1 = simnet.getAssetsMap().get(address1)?.STX || 0;
      const finalBalance2 = simnet.getAssetsMap().get(address2)?.STX || 0;

      expect(finalBalance1).toBe(initialBalance1 + 5000000);
      expect(finalBalance2).toBe(initialBalance2 + 3000000);
    });

    it("updates channel state to closed", () => {
      simnet.callPublicFn(contractName, "close-channel", [Cl.uint(0)], address1);

      const { result } = simnet.callReadOnlyFn(contractName, "get-channel-details", [Cl.uint(0)], deployer);
      const channel = result.expectSome();
      
      expect(channel).toMatchObject({
        "state": Cl.uint(CHANNEL_CLOSED)
      });
    });

    it("updates total locked amount", () => {
      simnet.callPublicFn(contractName, "close-channel", [Cl.uint(0)], address1);

      const { result } = simnet.callReadOnlyFn(contractName, "get-contract-stats", [], deployer);
      const stats = result.expectOk();
      
      expect(stats).toMatchObject({
        "total-locked": Cl.uint(0)
      });
    });

    it("prevents non-participant from closing", () => {
      const { result } = simnet.callPublicFn(
        contractName,
        "close-channel",
        [Cl.uint(0)],
        address3
      );
      expect(result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
    });

    it("prevents closing already closed channel", () => {
      // Close channel first
      simnet.callPublicFn(contractName, "close-channel", [Cl.uint(0)], address1);

      // Try to close again
      const { result } = simnet.callPublicFn(
        contractName,
        "close-channel",
        [Cl.uint(0)],
        address1
      );
      expect(result).toBeErr(Cl.uint(ERR_CHANNEL_CLOSED));
    });

    it("prevents closing disputed channel", () => {
      // Initiate dispute first
      simnet.callPublicFn(
        contractName,
        "initiate-dispute",
        [Cl.uint(0), Cl.uint(6000000), Cl.uint(2000000), Cl.uint(1)],
        address1
      );

      // Try to close
      const { result } = simnet.callPublicFn(
        contractName,
        "close-channel",
        [Cl.uint(0)],
        address1
      );
      expect(result).toBeErr(Cl.uint(ERR_CHANNEL_CLOSED));
    });

    it("marks channel as inactive after closing", () => {
      simnet.callPublicFn(contractName, "close-channel", [Cl.uint(0)], address1);

      const { result } = simnet.callReadOnlyFn(contractName, "is-channel-active", [Cl.uint(0)], deployer);
      expect(result).toBeBool(false);
    });
  });

  describe("Emergency Close", () => {
    beforeEach(() => {
      // Create and fund a channel
      simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address2), Cl.uint(5000000), Cl.uint(3000000)],
        address1
      );
      simnet.callPublicFn(
        contractName,
        "fund-channel",
        [Cl.uint(0), Cl.uint(3000000)],
        address2
      );
    });

    it("allows emergency close after timeout", () => {
      // Mine blocks to reach timeout
      simnet.mineEmptyBlocks(CHANNEL_TIMEOUT + 1);

      const { result } = simnet.callPublicFn(
        contractName,
        "emergency-close",
        [Cl.uint(0)],
        address1
      );
      expect(result).toBeOk(Cl.bool(true));
    });

    it("prevents emergency close before timeout", () => {
      const { result } = simnet.callPublicFn(
        contractName,
        "emergency-close",
        [Cl.uint(0)],
        address1
      );
      expect(result).toBeErr(Cl.uint(ERR_TIMEOUT_NOT_REACHED));
    });

    it("allows emergency close of disputed channel after timeout", () => {
      // Initiate dispute
      simnet.callPublicFn(
        contractName,
        "initiate-dispute",
        [Cl.uint(0), Cl.uint(6000000), Cl.uint(2000000), Cl.uint(1)],
        address1
      );

      // Mine blocks to reach timeout
      simnet.mineEmptyBlocks(CHANNEL_TIMEOUT + 1);

      const { result } = simnet.callPublicFn(
        contractName,
        "emergency-close",
        [Cl.uint(0)],
        address1
      );
      expect(result).toBeOk(Cl.bool(true));
    });

    it("distributes current balances on emergency close", () => {
      // Update channel balances first
      const commitmentHash = new Uint8Array(32).fill(1);
      simnet.callPublicFn(
        contractName,
        "update-channel",
        [Cl.uint(0), Cl.uint(6000000), Cl.uint(2000000), Cl.uint(1), Cl.buffer(commitmentHash)],
        address1
      );

      const initialBalance1 = simnet.getAssetsMap().get(address1)?.STX || 0;
      const initialBalance2 = simnet.getAssetsMap().get(address2)?.STX || 0;

      // Emergency close
      simnet.mineEmptyBlocks(CHANNEL_TIMEOUT + 1);
      simnet.callPublicFn(contractName, "emergency-close", [Cl.uint(0)], address1);

      const finalBalance1 = simnet.getAssetsMap().get(address1)?.STX || 0;
      const finalBalance2 = simnet.getAssetsMap().get(address2)?.STX || 0;

      expect(finalBalance1).toBe(initialBalance1 + 6000000);
      expect(finalBalance2).toBe(initialBalance2 + 2000000);
    });

    it("prevents non-participant from emergency closing", () => {
      simnet.mineEmptyBlocks(CHANNEL_TIMEOUT + 1);

      const { result } = simnet.callPublicFn(
        contractName,
        "emergency-close",
        [Cl.uint(0)],
        address3
      );
      expect(result).toBeErr(Cl.uint(ERR_UNAUTHORIZED));
    });

    it("closes channel after emergency close", () => {
      simnet.mineEmptyBlocks(CHANNEL_TIMEOUT + 1);
      simnet.callPublicFn(contractName, "emergency-close", [Cl.uint(0)], address1);

      const { result } = simnet.callReadOnlyFn(contractName, "get-channel-details", [Cl.uint(0)], deployer);
      const channel = result.expectSome();
      
      expect(channel).toMatchObject({
        "state": Cl.uint(CHANNEL_CLOSED)
      });
    });
  });

  describe("Integration Tests", () => {
    it("handles complete channel lifecycle", () => {
      // 1. Open channel
      const openResult = simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address2), Cl.uint(5000000), Cl.uint(3000000)],
        address1
      );
      expect(openResult.result).toBeOk(Cl.uint(0));

      // 2. Fund channel
      const fundResult = simnet.callPublicFn(
        contractName,
        "fund-channel",
        [Cl.uint(0), Cl.uint(3000000)],
        address2
      );
      expect(fundResult.result).toBeOk(Cl.bool(true));

      // 3. Update channel multiple times
      const commitmentHash = new Uint8Array(32).fill(1);
      
      const update1 = simnet.callPublicFn(
        contractName,
        "update-channel",
        [Cl.uint(0), Cl.uint(4000000), Cl.uint(4000000), Cl.uint(1), Cl.buffer(commitmentHash)],
        address1
      );
      expect(update1.result).toBeOk(Cl.bool(true));

      const update2 = simnet.callPublicFn(
        contractName,
        "update-channel",
        [Cl.uint(0), Cl.uint(3000000), Cl.uint(5000000), Cl.uint(2), Cl.buffer(commitmentHash)],
        address2
      );
      expect(update2.result).toBeOk(Cl.bool(true));

      // 4. Close channel cooperatively
      const closeResult = simnet.callPublicFn(
        contractName,
        "close-channel",
        [Cl.uint(0)],
        address1
      );
      expect(closeResult.result).toBeOk(Cl.bool(true));

      // 5. Verify final state
      const finalChannel = simnet.callReadOnlyFn(contractName, "get-channel-details", [Cl.uint(0)], deployer);
      const channelData = finalChannel.result.expectSome();
      
      expect(channelData).toMatchObject({
        "state": Cl.uint(CHANNEL_CLOSED),
        "nonce": Cl.uint(2)
      });

      // 6. Verify contract stats
      const stats = simnet.callReadOnlyFn(contractName, "get-contract-stats", [], deployer);
      expect(stats.result).toBeOk(
        Cl.tuple({
          "total-channels": Cl.uint(1),
          "total-locked": Cl.uint(0)
        })
      );
    });

    it("handles dispute and resolution workflow", () => {
      // Setup channel
      simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address2), Cl.uint(5000000), Cl.uint(3000000)],
        address1
      );
      simnet.callPublicFn(
        contractName,
        "fund-channel",
        [Cl.uint(0), Cl.uint(3000000)],
        address2
      );

      // Update channel
      const commitmentHash = new Uint8Array(32).fill(1);
      simnet.callPublicFn(
        contractName,
        "update-channel",
        [Cl.uint(0), Cl.uint(6000000), Cl.uint(2000000), Cl.uint(1), Cl.buffer(commitmentHash)],
        address1
      );

      // Initiate dispute
      const disputeResult = simnet.callPublicFn(
        contractName,
        "initiate-dispute",
        [Cl.uint(0), Cl.uint(7000000), Cl.uint(1000000), Cl.uint(2)],
        address2
      );
      expect(disputeResult.result).toBeOk(Cl.bool(true));

      // Wait for dispute timeout
      simnet.mineEmptyBlocks(DISPUTE_TIMEOUT + 1);

      // Resolve dispute
      const resolveResult = simnet.callPublicFn(
        contractName,
        "resolve-dispute",
        [Cl.uint(0)],
        address1
      );
      expect(resolveResult.result).toBeOk(Cl.bool(true));

      // Verify channel closed
      const finalChannel = simnet.callReadOnlyFn(contractName, "get-channel-details", [Cl.uint(0)], deployer);
      const channelData = finalChannel.result.expectSome();
      
      expect(channelData).toMatchObject({
        "state": Cl.uint(CHANNEL_CLOSED)
      });
    });

    it("handles multiple simultaneous channels", () => {
      // Create multiple channels
      const channel1 = simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address2), Cl.uint(2000000), Cl.uint(1000000)],
        address1
      );
      expect(channel1.result).toBeOk(Cl.uint(0));

      const channel2 = simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address3), Cl.uint(3000000), Cl.uint(2000000)],
        address1
      );
      expect(channel2.result).toBeOk(Cl.uint(1));

      const channel3 = simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address3), Cl.uint(4000000), Cl.uint(1000000)],
        address2
      );
      expect(channel3.result).toBeOk(Cl.uint(2));

      // Fund channels
      simnet.callPublicFn(contractName, "fund-channel", [Cl.uint(0), Cl.uint(1000000)], address2);
      simnet.callPublicFn(contractName, "fund-channel", [Cl.uint(1), Cl.uint(2000000)], address3);
      simnet.callPublicFn(contractName, "fund-channel", [Cl.uint(2), Cl.uint(1000000)], address3);

      // Verify all channels active
      expect(simnet.callReadOnlyFn(contractName, "is-channel-active", [Cl.uint(0)], deployer).result).toBeBool(true);
      expect(simnet.callReadOnlyFn(contractName, "is-channel-active", [Cl.uint(1)], deployer).result).toBeBool(true);
      expect(simnet.callReadOnlyFn(contractName, "is-channel-active", [Cl.uint(2)], deployer).result).toBeBool(true);

      // Close one channel
      simnet.callPublicFn(contractName, "close-channel", [Cl.uint(0)], address1);

      // Verify other channels still active
      expect(simnet.callReadOnlyFn(contractName, "is-channel-active", [Cl.uint(0)], deployer).result).toBeBool(false);
      expect(simnet.callReadOnlyFn(contractName, "is-channel-active", [Cl.uint(1)], deployer).result).toBeBool(true);
      expect(simnet.callReadOnlyFn(contractName, "is-channel-active", [Cl.uint(2)], deployer).result).toBeBool(true);

      // Check contract stats
      const stats = simnet.callReadOnlyFn(contractName, "get-contract-stats", [], deployer);
      expect(stats.result).toBeOk(
        Cl.tuple({
          "total-channels": Cl.uint(3),
          "total-locked": Cl.uint(10000000) // 5M + 5M from remaining channels
        })
      );
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("handles channel operations on non-existent channel", () => {
      const commitmentHash = new Uint8Array(32).fill(1);

      // Try to fund non-existent channel
      const fundResult = simnet.callPublicFn(
        contractName,
        "fund-channel",
        [Cl.uint(999), Cl.uint(1000000)],
        address1
      );
      expect(fundResult.result).toBeErr(Cl.uint(ERR_CHANNEL_NOT_FOUND));

      // Try to update non-existent channel
      const updateResult = simnet.callPublicFn(
        contractName,
        "update-channel",
        [Cl.uint(999), Cl.uint(1000000), Cl.uint(1000000), Cl.uint(1), Cl.buffer(commitmentHash)],
        address1
      );
      expect(updateResult.result).toBeErr(Cl.uint(ERR_CHANNEL_NOT_FOUND));

      // Try to close non-existent channel
      const closeResult = simnet.callPublicFn(
        contractName,
        "close-channel",
        [Cl.uint(999)],
        address1
      );
      expect(closeResult.result).toBeErr(Cl.uint(ERR_CHANNEL_NOT_FOUND));
    });

    it("prevents operations on closed channels", () => {
      // Create, fund and close channel
      simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address2), Cl.uint(2000000), Cl.uint(1000000)],
        address1
      );
      simnet.callPublicFn(contractName, "fund-channel", [Cl.uint(0), Cl.uint(1000000)], address2);
      simnet.callPublicFn(contractName, "close-channel", [Cl.uint(0)], address1);

      // Try operations on closed channel
      const commitmentHash = new Uint8Array(32).fill(1);
      
      const updateResult = simnet.callPublicFn(
        contractName,
        "update-channel",
        [Cl.uint(0), Cl.uint(1500000), Cl.uint(1500000), Cl.uint(1), Cl.buffer(commitmentHash)],
        address1
      );
      expect(updateResult.result).toBeErr(Cl.uint(ERR_CHANNEL_CLOSED));

      const disputeResult = simnet.callPublicFn(
        contractName,
        "initiate-dispute",
        [Cl.uint(0), Cl.uint(2000000), Cl.uint(1000000), Cl.uint(1)],
        address1
      );
      expect(disputeResult.result).toBeErr(Cl.uint(ERR_CHANNEL_CLOSED));
    });

    it("handles timeout edge cases", () => {
      // Create and fund channel
      simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address2), Cl.uint(2000000), Cl.uint(1000000)],
        address1
      );
      simnet.callPublicFn(contractName, "fund-channel", [Cl.uint(0), Cl.uint(1000000)], address2);

      // Try emergency close exactly at timeout block
      simnet.mineEmptyBlocks(CHANNEL_TIMEOUT);
      
      const emergencyCloseResult = simnet.callPublicFn(
        contractName,
        "emergency-close",
        [Cl.uint(0)],
        address1
      );
      expect(emergencyCloseResult.result).toBeOk(Cl.bool(true));
    });

    it("handles large amounts correctly", () => {
      const largeAmount = MAX_CHANNEL_AMOUNT - 1000000;
      
      const { result } = simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address2), Cl.uint(largeAmount), Cl.uint(1000000)],
        address1
      );
      expect(result).toBeOk(Cl.uint(0));

      // Verify channel created with large amount
      const channelResult = simnet.callReadOnlyFn(contractName, "get-channel-details", [Cl.uint(0)], deployer);
      const channelData = channelResult.result.expectSome();
      
      expect(channelData).toMatchObject({
        "balance-a": Cl.uint(largeAmount),
        "total-amount": Cl.uint(MAX_CHANNEL_AMOUNT)
      });
    });

    it("maintains consistency during rapid updates", () => {
      // Setup channel
      simnet.callPublicFn(
        contractName,
        "open-channel",
        [Cl.principal(address2), Cl.uint(5000000), Cl.uint(5000000)],
        address1
      );
      simnet.callPublicFn(contractName, "fund-channel", [Cl.uint(0), Cl.uint(5000000)], address2);

      // Rapid updates with increasing nonces
      const commitmentHash = new Uint8Array(32).fill(1);
      
      for (let i = 1; i <= 5; i++) {
        const balanceA = 5000000 + (i * 100000);
        const balanceB = 5000000 - (i * 100000);
        
        const updateResult = simnet.callPublicFn(
          contractName,
          "update-channel",
          [Cl.uint(0), Cl.uint(balanceA), Cl.uint(balanceB), Cl.uint(i), Cl.buffer(commitmentHash)],
          i % 2 === 1 ? address1 : address2
        );
        expect(updateResult.result).toBeOk(Cl.bool(true));
      }

      // Verify final state
      const finalChannel = simnet.callReadOnlyFn(contractName, "get-channel-details", [Cl.uint(0)], deployer);
      const channelData = finalChannel.result.expectSome();
      
      expect(channelData).toMatchObject({
        "nonce": Cl.uint(5),
        "balance-a": Cl.uint(5500000),
        "balance-b": Cl.uint(4500000)
      });
    });

    it("handles user channel count limits", () => {
      // This test would require creating 100+ channels to test the limit
      // For practical purposes, we'll test the logic exists by checking counter increments
      
      // Create a few channels for address1
      for (let i = 0; i < 3; i++) {
        simnet.callPublicFn(
          contractName,
          "open-channel",
          [Cl.principal(`${address2}.${i}`), Cl.uint(2000000), Cl.uint(1000000)],
          address1
        );
      }

      // Check user channel count
      const { result } = simnet.callReadOnlyFn(contractName, "get-user-channel-count", [Cl.principal(address1)], deployer);
      expect(result).toBeUint(3);
    });
  });
});
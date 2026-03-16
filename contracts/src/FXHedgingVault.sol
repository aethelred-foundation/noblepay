// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title FXHedgingVault
 * @author Aethelred Team
 * @notice Currency risk management contract for the NoblePay cross-border
 *         payment platform. Provides forward contracts, options-style hedging,
 *         multi-currency vault positions, oracle-driven FX rate feeds,
 *         mark-to-market valuation, and IFRS 9 compliance tracking.
 *
 * @dev Architecture overview:
 *
 * ┌───────────────────────────────────────────────────────────────────┐
 * │                      FX HEDGING VAULT                             │
 * ├───────────────────────────────────────────────────────────────────┤
 * │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
 * │  │  Forwards        │  │  Options          │  │  Oracle        │  │
 * │  │  ──────────────  │  │  ──────────────── │  │  ──────────── │  │
 * │  │  • lock rate     │  │  • pay premium    │  │  • rate feeds  │  │
 * │  │  • settle at     │  │  • upside cap     │  │  • multi-src   │  │
 * │  │    maturity       │  │  • exercise       │  │  • staleness   │  │
 * │  └─────────────────┘  └──────────────────┘  └────────────────┘  │
 * │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
 * │  │  Portfolio        │  │  Margin           │  │  Compliance    │  │
 * │  │  ──────────────  │  │  ──────────────── │  │  ──────────── │  │
 * │  │  • multi-ccy     │  │  • requirements   │  │  • IFRS 9      │  │
 * │  │  • netting       │  │  • liquidation    │  │  • hedge eff.  │  │
 * │  │  • rebalance     │  │  • margin calls   │  │  • audit trail │  │
 * │  └─────────────────┘  └──────────────────┘  └────────────────┘  │
 * └───────────────────────────────────────────────────────────────────┘
 *
 * Supported currency pairs:
 *   AED/USD, GBP/USD, EUR/USD, JPY/USD, CHF/USD, SGD/USD, HKD/USD,
 *   SAR/USD, CNY/USD, INR/USD
 *
 * Rate representation:
 *   All FX rates are stored with 8 decimal precision (1 USD = 1_00000000).
 *   Example: AED/USD at 3.6725 is stored as 3_67250000.
 */
contract FXHedgingVault is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────────────────────
    // Roles
    // ──────────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant RISK_MANAGER_ROLE = keccak256("RISK_MANAGER_ROLE");
    bytes32 public constant LIQUIDATOR_ROLE = keccak256("LIQUIDATOR_ROLE");

    // ──────────────────────────────────────────────────────────────
    // Enums
    // ──────────────────────────────────────────────────────────────

    /// @notice Type of hedging instrument.
    enum HedgeType {
        FORWARD,        // Obligatory — must settle at locked rate
        OPTION_CALL,    // Right to buy base currency at strike
        OPTION_PUT      // Right to sell base currency at strike
    }

    /// @notice Lifecycle status of a hedging position.
    enum PositionStatus {
        ACTIVE,
        MATURED,
        SETTLED,
        EXERCISED,
        EXPIRED,
        LIQUIDATED,
        EMERGENCY_UNWOUND
    }

    // ──────────────────────────────────────────────────────────────
    // Structs
    // ──────────────────────────────────────────────────────────────

    /// @notice FX rate data from oracle.
    struct FXRate {
        bytes32 pairId;              // e.g., keccak256("AED/USD")
        uint256 rate;                // 8-decimal precision
        uint256 updatedAt;
        address submittedBy;
    }

    /// @notice Currency pair configuration.
    struct CurrencyPair {
        bytes3 baseCurrency;         // e.g., "AED"
        bytes3 quoteCurrency;        // e.g., "USD"
        bytes32 pairId;              // keccak256(baseCurrency, quoteCurrency)
        bool active;
        uint256 maxHedgeRatio;       // Maximum hedge ratio in basis points (10000 = 100%)
        uint256 marginRequirementBps; // Initial margin in basis points
        uint256 maintenanceMarginBps; // Maintenance margin in basis points
    }

    /// @notice Hedging position record.
    struct HedgePosition {
        bytes32 positionId;
        address hedger;              // Business hedging their exposure
        bytes32 pairId;              // Currency pair being hedged
        HedgeType hedgeType;
        PositionStatus status;
        uint256 notionalAmount;      // Notional amount in base currency (8 dec)
        uint256 lockedRate;          // Locked/strike FX rate (8 dec)
        uint256 premium;             // Premium paid for options (0 for forwards)
        address collateralToken;     // Stablecoin used as collateral
        uint256 collateralAmount;    // Margin deposited
        uint256 createdAt;
        uint256 maturityDate;
        uint256 settledAt;
        uint256 settlementAmount;    // Final settlement amount
        uint256 markToMarketValue;   // Latest MtM valuation
        uint256 lastMtMUpdate;
    }

    /// @notice Portfolio-level hedge summary for a business.
    struct HedgePortfolio {
        uint256 totalNotional;       // Total notional across all positions
        uint256 totalCollateral;     // Total collateral deposited
        uint256 totalPremiumPaid;    // Total premiums paid for options
        uint256 totalPnL;            // Cumulative realized P&L
        uint256 unrealizedPnL;       // Current unrealized P&L
        uint256 positionCount;       // Number of active positions
        uint256 lastRebalanced;
    }

    /// @notice Hedge effectiveness measurement for IFRS 9 compliance.
    struct HedgeEffectiveness {
        bytes32 positionId;
        uint256 hedgedItemChange;    // Change in value of hedged item
        uint256 hedgingInstrChange;  // Change in value of hedging instrument
        uint256 effectivenessRatio;  // Ratio in basis points (8000-12500 for valid hedge)
        uint256 measuredAt;
        bool isEffective;            // True if ratio is within 80%-125%
    }

    // ──────────────────────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────────────────────

    /// @notice FX rate precision (8 decimals).
    uint256 public constant RATE_PRECISION = 1e8;

    /// @notice Maximum staleness for FX rates (5 minutes).
    uint256 public constant MAX_RATE_STALENESS = 5 minutes;

    /// @notice Minimum hedge effectiveness ratio (80% = 8000 bps).
    uint256 public constant MIN_HEDGE_EFFECTIVENESS = 8000;

    /// @notice Maximum hedge effectiveness ratio (125% = 12500 bps).
    uint256 public constant MAX_HEDGE_EFFECTIVENESS = 12500;

    /// @notice Maximum position maturity (2 years).
    uint256 public constant MAX_MATURITY = 730 days;

    /// @notice Liquidation bonus in basis points (5%).
    uint256 public constant LIQUIDATION_BONUS_BPS = 500;

    /// @notice Maximum number of active positions per business.
    uint256 public constant MAX_POSITIONS_PER_BUSINESS = 100;

    // ──────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────

    /// @notice Currency pair configurations keyed by pair ID.
    mapping(bytes32 => CurrencyPair) public currencyPairs;

    /// @notice Active currency pair IDs.
    bytes32[] public activePairIds;

    /// @notice Latest FX rates keyed by pair ID.
    mapping(bytes32 => FXRate) public latestRates;

    /// @notice Hedge positions keyed by position ID.
    mapping(bytes32 => HedgePosition) public positions;

    /// @notice Portfolio summaries keyed by business address.
    mapping(address => HedgePortfolio) public portfolios;

    /// @notice Position IDs per business.
    mapping(address => bytes32[]) public businessPositions;

    /// @notice Hedge effectiveness records keyed by position ID.
    mapping(bytes32 => HedgeEffectiveness) public hedgeEffectiveness;

    /// @notice Supported collateral tokens (stablecoins).
    mapping(address => bool) public supportedCollateral;

    /// @notice Protocol treasury for premium and fee collection.
    address public treasury;

    /// @notice Position nonce for unique ID generation.
    uint256 public positionNonce;

    /// @notice Protocol fee on forward settlements in basis points.
    uint256 public settlementFeeBps;

    // ──────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────

    event CurrencyPairAdded(
        bytes32 indexed pairId,
        bytes3 baseCurrency,
        bytes3 quoteCurrency,
        uint256 marginRequirementBps
    );

    event CurrencyPairUpdated(bytes32 indexed pairId, bool active);

    event FXRateUpdated(
        bytes32 indexed pairId,
        uint256 rate,
        uint256 timestamp,
        address indexed oracle
    );

    event ForwardCreated(
        bytes32 indexed positionId,
        address indexed hedger,
        bytes32 indexed pairId,
        uint256 notionalAmount,
        uint256 lockedRate,
        uint256 maturityDate
    );

    event OptionCreated(
        bytes32 indexed positionId,
        address indexed hedger,
        bytes32 indexed pairId,
        HedgeType hedgeType,
        uint256 notionalAmount,
        uint256 strikeRate,
        uint256 premium
    );

    event PositionSettled(
        bytes32 indexed positionId,
        address indexed hedger,
        uint256 settlementAmount,
        int256 pnl
    );

    event OptionExercised(
        bytes32 indexed positionId,
        address indexed hedger,
        uint256 exerciseRate,
        uint256 settlementAmount
    );

    event OptionExpired(bytes32 indexed positionId);

    event PositionLiquidated(
        bytes32 indexed positionId,
        address indexed liquidator,
        uint256 collateralSeized,
        uint256 liquidationBonus
    );

    event MarginAdded(
        bytes32 indexed positionId,
        address indexed hedger,
        uint256 amount
    );

    event MarkToMarketUpdated(
        bytes32 indexed positionId,
        uint256 mtmValue,
        uint256 timestamp
    );

    event HedgeEffectivenessAssessed(
        bytes32 indexed positionId,
        uint256 effectivenessRatio,
        bool isEffective
    );

    event PortfolioRebalanced(
        address indexed hedger,
        uint256 positionsAdjusted,
        uint256 timestamp
    );

    event EmergencyUnwind(
        bytes32 indexed positionId,
        uint256 unwindAmount,
        uint256 timestamp
    );

    event CollateralTokenUpdated(address indexed token, bool supported);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event SettlementFeeUpdated(uint256 oldFee, uint256 newFee);

    // ──────────────────────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error UnsupportedCollateral();
    error PairNotFound();
    error PairNotActive();
    error PositionNotFound();
    error InvalidPositionStatus(PositionStatus current);
    error RateStale(uint256 updatedAt, uint256 maxAge);
    error MaturityInPast();
    error MaturityTooFar();
    error InsufficientMargin(uint256 provided, uint256 required);
    error NotPositionOwner();
    error PositionNotMatured();
    error OptionNotInTheMoney();
    error MarginSufficient();
    error MaxPositionsReached();
    error PairAlreadyExists();
    error InvalidFee();
    error InvalidRate();

    // ──────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Deploys FXHedgingVault.
     * @param _admin           Admin address.
     * @param _treasury        Treasury address for fee collection.
     * @param _settlementFeeBps Settlement fee in basis points.
     */
    constructor(
        address _admin,
        address _treasury,
        uint256 _settlementFeeBps
    ) {
        if (_admin == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_settlementFeeBps > 500) revert InvalidFee(); // Max 5%

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);

        treasury = _treasury;
        settlementFeeBps = _settlementFeeBps;
    }

    // ──────────────────────────────────────────────────────────────
    // External — Oracle Rate Submission
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Submits a new FX rate from an authorized oracle.
     * @param _pairId  Currency pair identifier.
     * @param _rate    FX rate with 8-decimal precision.
     */
    function submitFXRate(
        bytes32 _pairId,
        uint256 _rate
    ) external onlyRole(ORACLE_ROLE) whenNotPaused {
        if (currencyPairs[_pairId].pairId == bytes32(0)) revert PairNotFound();
        if (_rate == 0) revert InvalidRate();

        latestRates[_pairId] = FXRate({
            pairId: _pairId,
            rate: _rate,
            updatedAt: block.timestamp,
            submittedBy: msg.sender
        });

        emit FXRateUpdated(_pairId, _rate, block.timestamp, msg.sender);
    }

    /**
     * @notice Batch submits FX rates for multiple currency pairs.
     * @param _pairIds Array of pair IDs.
     * @param _rates   Array of corresponding rates.
     */
    function batchSubmitFXRates(
        bytes32[] calldata _pairIds,
        uint256[] calldata _rates
    ) external onlyRole(ORACLE_ROLE) whenNotPaused {
        require(_pairIds.length == _rates.length, "FXHedgingVault: array mismatch");

        for (uint256 i; i < _pairIds.length;) {
            if (currencyPairs[_pairIds[i]].pairId == bytes32(0)) revert PairNotFound();
            if (_rates[i] == 0) revert InvalidRate();

            latestRates[_pairIds[i]] = FXRate({
                pairId: _pairIds[i],
                rate: _rates[i],
                updatedAt: block.timestamp,
                submittedBy: msg.sender
            });

            emit FXRateUpdated(_pairIds[i], _rates[i], block.timestamp, msg.sender);

            unchecked { ++i; }
        }
    }

    // ──────────────────────────────────────────────────────────────
    // External — Forward Contracts
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Creates a forward contract to lock in an FX rate for future settlement.
     * @param _pairId          Currency pair to hedge.
     * @param _notionalAmount  Notional amount in base currency (8 dec).
     * @param _maturityDate    Settlement date for the forward.
     * @param _collateralToken Stablecoin used as margin collateral.
     * @param _collateralAmount Initial margin deposit.
     * @return positionId      Unique position identifier.
     */
    function createForward(
        bytes32 _pairId,
        uint256 _notionalAmount,
        uint256 _maturityDate,
        address _collateralToken,
        uint256 _collateralAmount
    ) external whenNotPaused nonReentrant returns (bytes32 positionId) {
        _validateNewPosition(_pairId, _notionalAmount, _maturityDate, _collateralToken);

        // Get current rate as the locked rate
        FXRate storage currentRate = latestRates[_pairId];
        _requireFreshRate(currentRate);

        // Validate margin requirement
        CurrencyPair storage pair = currencyPairs[_pairId];
        uint256 requiredMargin = (_notionalAmount * pair.marginRequirementBps) / 10_000;
        if (_collateralAmount < requiredMargin) {
            revert InsufficientMargin(_collateralAmount, requiredMargin);
        }

        positionId = keccak256(
            abi.encodePacked(msg.sender, _pairId, _notionalAmount, block.timestamp, positionNonce++)
        );

        positions[positionId] = HedgePosition({
            positionId: positionId,
            hedger: msg.sender,
            pairId: _pairId,
            hedgeType: HedgeType.FORWARD,
            status: PositionStatus.ACTIVE,
            notionalAmount: _notionalAmount,
            lockedRate: currentRate.rate,
            premium: 0,
            collateralToken: _collateralToken,
            collateralAmount: _collateralAmount,
            createdAt: block.timestamp,
            maturityDate: _maturityDate,
            settledAt: 0,
            settlementAmount: 0,
            markToMarketValue: _notionalAmount,
            lastMtMUpdate: block.timestamp
        });

        // Update portfolio
        HedgePortfolio storage portfolio = portfolios[msg.sender];
        portfolio.totalNotional += _notionalAmount;
        portfolio.totalCollateral += _collateralAmount;
        portfolio.positionCount++;
        businessPositions[msg.sender].push(positionId);

        // Transfer collateral
        IERC20(_collateralToken).safeTransferFrom(msg.sender, address(this), _collateralAmount);

        emit ForwardCreated(positionId, msg.sender, _pairId, _notionalAmount, currentRate.rate, _maturityDate);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Options
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Creates an options-style hedge with premium payment.
     * @dev The hedger pays a premium for the right (not obligation) to
     *      exchange at the strike rate. Allows upside participation.
     * @param _pairId          Currency pair to hedge.
     * @param _hedgeType       OPTION_CALL or OPTION_PUT.
     * @param _notionalAmount  Notional amount in base currency (8 dec).
     * @param _strikeRate      Strike FX rate (8 dec).
     * @param _premium         Premium to pay for the option.
     * @param _maturityDate    Expiry date of the option.
     * @param _collateralToken Stablecoin for premium payment.
     * @param _collateralAmount Margin collateral for the position.
     * @return positionId      Unique position identifier.
     */
    function createOption(
        bytes32 _pairId,
        HedgeType _hedgeType,
        uint256 _notionalAmount,
        uint256 _strikeRate,
        uint256 _premium,
        uint256 _maturityDate,
        address _collateralToken,
        uint256 _collateralAmount
    ) external whenNotPaused nonReentrant returns (bytes32 positionId) {
        require(
            _hedgeType == HedgeType.OPTION_CALL || _hedgeType == HedgeType.OPTION_PUT,
            "FXHedgingVault: invalid option type"
        );
        _validateNewPosition(_pairId, _notionalAmount, _maturityDate, _collateralToken);
        if (_strikeRate == 0) revert InvalidRate();

        positionId = keccak256(
            abi.encodePacked(msg.sender, _pairId, _notionalAmount, _strikeRate, block.timestamp, positionNonce++)
        );

        positions[positionId] = HedgePosition({
            positionId: positionId,
            hedger: msg.sender,
            pairId: _pairId,
            hedgeType: _hedgeType,
            status: PositionStatus.ACTIVE,
            notionalAmount: _notionalAmount,
            lockedRate: _strikeRate,
            premium: _premium,
            collateralToken: _collateralToken,
            collateralAmount: _collateralAmount,
            createdAt: block.timestamp,
            maturityDate: _maturityDate,
            settledAt: 0,
            settlementAmount: 0,
            markToMarketValue: _notionalAmount,
            lastMtMUpdate: block.timestamp
        });

        // Update portfolio
        HedgePortfolio storage portfolio = portfolios[msg.sender];
        portfolio.totalNotional += _notionalAmount;
        portfolio.totalCollateral += _collateralAmount;
        portfolio.totalPremiumPaid += _premium;
        portfolio.positionCount++;
        businessPositions[msg.sender].push(positionId);

        // Transfer collateral + premium
        uint256 totalDeposit = _collateralAmount + _premium;
        IERC20(_collateralToken).safeTransferFrom(msg.sender, address(this), totalDeposit);

        // Send premium to treasury
        if (_premium > 0) {
            IERC20(_collateralToken).safeTransfer(treasury, _premium);
        }

        emit OptionCreated(positionId, msg.sender, _pairId, _hedgeType, _notionalAmount, _strikeRate, _premium);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Settlement & Exercise
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Settles a matured forward contract.
     * @dev Calculates P&L based on locked rate vs. spot rate at maturity.
     * @param _positionId Position to settle.
     */
    function settleForward(bytes32 _positionId) external whenNotPaused nonReentrant {
        HedgePosition storage pos = positions[_positionId];
        if (pos.createdAt == 0) revert PositionNotFound();
        if (pos.hedger != msg.sender && !hasRole(ADMIN_ROLE, msg.sender)) revert NotPositionOwner();
        if (pos.status != PositionStatus.ACTIVE) revert InvalidPositionStatus(pos.status);
        if (pos.hedgeType != HedgeType.FORWARD) revert InvalidPositionStatus(pos.status);
        if (block.timestamp < pos.maturityDate) revert PositionNotMatured();

        FXRate storage currentRate = latestRates[pos.pairId];
        _requireFreshRate(currentRate);

        // Calculate settlement: difference between locked and spot rate applied to notional
        int256 pnl;
        uint256 settlementAmount;

        if (currentRate.rate >= pos.lockedRate) {
            // Rate moved favorably (base currency appreciated)
            uint256 gain = ((currentRate.rate - pos.lockedRate) * pos.notionalAmount) / RATE_PRECISION;
            settlementAmount = pos.collateralAmount + gain;
            pnl = int256(gain);
        } else {
            // Rate moved unfavorably (base currency depreciated)
            uint256 loss = ((pos.lockedRate - currentRate.rate) * pos.notionalAmount) / RATE_PRECISION;
            settlementAmount = loss >= pos.collateralAmount ? 0 : pos.collateralAmount - loss;
            pnl = -int256(loss);
        }

        // Apply settlement fee
        uint256 fee = (pos.collateralAmount * settlementFeeBps) / 10_000;
        if (settlementAmount > fee) {
            settlementAmount -= fee;
        } else {
            fee = settlementAmount;
            settlementAmount = 0;
        }

        pos.status = PositionStatus.SETTLED;
        pos.settledAt = block.timestamp;
        pos.settlementAmount = settlementAmount;

        // Update portfolio
        HedgePortfolio storage portfolio = portfolios[pos.hedger];
        portfolio.totalNotional -= pos.notionalAmount;
        portfolio.totalCollateral -= pos.collateralAmount;
        portfolio.positionCount--;
        if (pnl > 0) {
            portfolio.totalPnL += uint256(pnl);
        }

        // Transfer settlement
        if (settlementAmount > 0) {
            IERC20(pos.collateralToken).safeTransfer(pos.hedger, settlementAmount);
        }
        if (fee > 0) {
            IERC20(pos.collateralToken).safeTransfer(treasury, fee);
        }

        emit PositionSettled(_positionId, pos.hedger, settlementAmount, pnl);
    }

    /**
     * @notice Exercises an in-the-money option before or at expiry.
     * @param _positionId Option position to exercise.
     */
    function exerciseOption(bytes32 _positionId) external whenNotPaused nonReentrant {
        HedgePosition storage pos = positions[_positionId];
        if (pos.createdAt == 0) revert PositionNotFound();
        if (pos.hedger != msg.sender) revert NotPositionOwner();
        if (pos.status != PositionStatus.ACTIVE) revert InvalidPositionStatus(pos.status);
        require(
            pos.hedgeType == HedgeType.OPTION_CALL || pos.hedgeType == HedgeType.OPTION_PUT,
            "FXHedgingVault: not an option"
        );
        if (block.timestamp > pos.maturityDate) revert PositionNotMatured();

        FXRate storage currentRate = latestRates[pos.pairId];
        _requireFreshRate(currentRate);

        // Check if option is in-the-money
        bool inTheMoney;
        uint256 intrinsicValue;

        if (pos.hedgeType == HedgeType.OPTION_CALL) {
            // Call is ITM when spot > strike
            inTheMoney = currentRate.rate > pos.lockedRate;
            if (inTheMoney) {
                intrinsicValue = ((currentRate.rate - pos.lockedRate) * pos.notionalAmount) / RATE_PRECISION;
            }
        } else {
            // Put is ITM when spot < strike
            inTheMoney = currentRate.rate < pos.lockedRate;
            if (inTheMoney) {
                intrinsicValue = ((pos.lockedRate - currentRate.rate) * pos.notionalAmount) / RATE_PRECISION;
            }
        }

        if (!inTheMoney) revert OptionNotInTheMoney();

        uint256 settlementAmount = pos.collateralAmount + intrinsicValue;
        uint256 fee = (intrinsicValue * settlementFeeBps) / 10_000;
        settlementAmount -= fee;

        pos.status = PositionStatus.EXERCISED;
        pos.settledAt = block.timestamp;
        pos.settlementAmount = settlementAmount;

        // Update portfolio
        HedgePortfolio storage portfolio = portfolios[pos.hedger];
        portfolio.totalNotional -= pos.notionalAmount;
        portfolio.totalCollateral -= pos.collateralAmount;
        portfolio.positionCount--;
        portfolio.totalPnL += intrinsicValue;

        IERC20(pos.collateralToken).safeTransfer(pos.hedger, settlementAmount);
        if (fee > 0) {
            IERC20(pos.collateralToken).safeTransfer(treasury, fee);
        }

        emit OptionExercised(_positionId, pos.hedger, currentRate.rate, settlementAmount);
    }

    /**
     * @notice Marks an expired option as expired and returns collateral.
     * @param _positionId Option that has expired without exercise.
     */
    function expireOption(bytes32 _positionId) external whenNotPaused nonReentrant {
        HedgePosition storage pos = positions[_positionId];
        if (pos.createdAt == 0) revert PositionNotFound();
        if (pos.status != PositionStatus.ACTIVE) revert InvalidPositionStatus(pos.status);
        require(
            pos.hedgeType == HedgeType.OPTION_CALL || pos.hedgeType == HedgeType.OPTION_PUT,
            "FXHedgingVault: not an option"
        );
        if (block.timestamp <= pos.maturityDate) revert PositionNotMatured();

        pos.status = PositionStatus.EXPIRED;
        pos.settledAt = block.timestamp;

        // Return collateral (premium already taken)
        HedgePortfolio storage portfolio = portfolios[pos.hedger];
        portfolio.totalNotional -= pos.notionalAmount;
        portfolio.totalCollateral -= pos.collateralAmount;
        portfolio.positionCount--;

        if (pos.collateralAmount > 0) {
            IERC20(pos.collateralToken).safeTransfer(pos.hedger, pos.collateralAmount);
        }

        emit OptionExpired(_positionId);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Margin & Liquidation
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Adds additional margin to an existing position.
     * @param _positionId Position to add margin to.
     * @param _amount     Amount of additional collateral.
     */
    function addMargin(
        bytes32 _positionId,
        uint256 _amount
    ) external whenNotPaused nonReentrant {
        HedgePosition storage pos = positions[_positionId];
        if (pos.createdAt == 0) revert PositionNotFound();
        if (pos.hedger != msg.sender) revert NotPositionOwner();
        if (pos.status != PositionStatus.ACTIVE) revert InvalidPositionStatus(pos.status);
        if (_amount == 0) revert ZeroAmount();

        pos.collateralAmount += _amount;
        portfolios[msg.sender].totalCollateral += _amount;

        IERC20(pos.collateralToken).safeTransferFrom(msg.sender, address(this), _amount);

        emit MarginAdded(_positionId, msg.sender, _amount);
    }

    /**
     * @notice Liquidates an under-margined position.
     * @dev Callable by liquidators when collateral drops below maintenance margin.
     * @param _positionId Position to liquidate.
     */
    function liquidatePosition(
        bytes32 _positionId
    ) external whenNotPaused nonReentrant onlyRole(LIQUIDATOR_ROLE) {
        HedgePosition storage pos = positions[_positionId];
        if (pos.createdAt == 0) revert PositionNotFound();
        if (pos.status != PositionStatus.ACTIVE) revert InvalidPositionStatus(pos.status);

        FXRate storage currentRate = latestRates[pos.pairId];
        _requireFreshRate(currentRate);

        // Calculate current margin ratio
        CurrencyPair storage pair = currencyPairs[pos.pairId];
        uint256 maintenanceMargin = (pos.notionalAmount * pair.maintenanceMarginBps) / 10_000;

        // Calculate unrealized loss
        uint256 unrealizedLoss;
        if (pos.hedgeType == HedgeType.FORWARD) {
            if (currentRate.rate < pos.lockedRate) {
                unrealizedLoss = ((pos.lockedRate - currentRate.rate) * pos.notionalAmount) / RATE_PRECISION;
            }
        }

        uint256 effectiveCollateral = unrealizedLoss >= pos.collateralAmount
            ? 0
            : pos.collateralAmount - unrealizedLoss;

        if (effectiveCollateral >= maintenanceMargin) revert MarginSufficient();

        // Liquidate
        uint256 liquidationBonus = (pos.collateralAmount * LIQUIDATION_BONUS_BPS) / 10_000;
        uint256 liquidatorReward = liquidationBonus > pos.collateralAmount
            ? pos.collateralAmount
            : liquidationBonus;
        uint256 remainder = pos.collateralAmount - liquidatorReward;

        pos.status = PositionStatus.LIQUIDATED;
        pos.settledAt = block.timestamp;

        // Update portfolio
        HedgePortfolio storage portfolio = portfolios[pos.hedger];
        portfolio.totalNotional -= pos.notionalAmount;
        portfolio.totalCollateral -= pos.collateralAmount;
        portfolio.positionCount--;

        // Transfer rewards
        if (liquidatorReward > 0) {
            IERC20(pos.collateralToken).safeTransfer(msg.sender, liquidatorReward);
        }
        if (remainder > 0) {
            IERC20(pos.collateralToken).safeTransfer(pos.hedger, remainder);
        }

        emit PositionLiquidated(_positionId, msg.sender, pos.collateralAmount, liquidatorReward);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Mark-to-Market & Hedge Effectiveness
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Updates mark-to-market valuation for a position.
     * @param _positionId Position to revalue.
     */
    function updateMarkToMarket(bytes32 _positionId) external whenNotPaused {
        HedgePosition storage pos = positions[_positionId];
        if (pos.createdAt == 0) revert PositionNotFound();
        if (pos.status != PositionStatus.ACTIVE) revert InvalidPositionStatus(pos.status);

        FXRate storage currentRate = latestRates[pos.pairId];
        _requireFreshRate(currentRate);

        // MtM = notional valued at current rate
        uint256 mtmValue = (pos.notionalAmount * currentRate.rate) / RATE_PRECISION;
        pos.markToMarketValue = mtmValue;
        pos.lastMtMUpdate = block.timestamp;

        // Update portfolio unrealized P&L
        uint256 originalValue = (pos.notionalAmount * pos.lockedRate) / RATE_PRECISION;
        if (mtmValue >= originalValue) {
            portfolios[pos.hedger].unrealizedPnL += (mtmValue - originalValue);
        }

        emit MarkToMarketUpdated(_positionId, mtmValue, block.timestamp);
    }

    /**
     * @notice Assesses hedge effectiveness for IFRS 9 compliance.
     * @dev Measures the ratio of hedged item value change to hedging
     *      instrument value change. Valid hedge: 80%-125%.
     * @param _positionId        Position to assess.
     * @param _hedgedItemChange  Change in value of the hedged item.
     */
    function assessHedgeEffectiveness(
        bytes32 _positionId,
        uint256 _hedgedItemChange
    ) external onlyRole(RISK_MANAGER_ROLE) whenNotPaused {
        HedgePosition storage pos = positions[_positionId];
        if (pos.createdAt == 0) revert PositionNotFound();

        FXRate storage currentRate = latestRates[pos.pairId];
        _requireFreshRate(currentRate);

        // Calculate hedging instrument change
        uint256 originalValue = (pos.notionalAmount * pos.lockedRate) / RATE_PRECISION;
        uint256 currentValue = (pos.notionalAmount * currentRate.rate) / RATE_PRECISION;
        uint256 hedgingInstrChange = currentValue > originalValue
            ? currentValue - originalValue
            : originalValue - currentValue;

        // Calculate effectiveness ratio (in bps, 10000 = 100%)
        uint256 effectivenessRatio;
        if (_hedgedItemChange > 0) {
            effectivenessRatio = (hedgingInstrChange * 10_000) / _hedgedItemChange;
        }

        bool isEffective = effectivenessRatio >= MIN_HEDGE_EFFECTIVENESS &&
                           effectivenessRatio <= MAX_HEDGE_EFFECTIVENESS;

        hedgeEffectiveness[_positionId] = HedgeEffectiveness({
            positionId: _positionId,
            hedgedItemChange: _hedgedItemChange,
            hedgingInstrChange: hedgingInstrChange,
            effectivenessRatio: effectivenessRatio,
            measuredAt: block.timestamp,
            isEffective: isEffective
        });

        emit HedgeEffectivenessAssessed(_positionId, effectivenessRatio, isEffective);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Emergency
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Emergency unwind of a position by admin.
     * @dev Returns remaining collateral to the hedger.
     * @param _positionId Position to unwind.
     */
    function emergencyUnwind(
        bytes32 _positionId
    ) external onlyRole(ADMIN_ROLE) nonReentrant {
        HedgePosition storage pos = positions[_positionId];
        if (pos.createdAt == 0) revert PositionNotFound();
        if (pos.status != PositionStatus.ACTIVE) revert InvalidPositionStatus(pos.status);

        pos.status = PositionStatus.EMERGENCY_UNWOUND;
        pos.settledAt = block.timestamp;

        HedgePortfolio storage portfolio = portfolios[pos.hedger];
        portfolio.totalNotional -= pos.notionalAmount;
        portfolio.totalCollateral -= pos.collateralAmount;
        portfolio.positionCount--;

        if (pos.collateralAmount > 0) {
            IERC20(pos.collateralToken).safeTransfer(pos.hedger, pos.collateralAmount);
        }

        emit EmergencyUnwind(_positionId, pos.collateralAmount, block.timestamp);
    }

    // ──────────────────────────────────────────────────────────────
    // View Functions
    // ──────────────────────────────────────────────────────────────

    /// @notice Returns the latest FX rate for a currency pair.
    function getLatestRate(bytes32 _pairId) external view returns (uint256 rate, uint256 updatedAt) {
        FXRate storage r = latestRates[_pairId];
        return (r.rate, r.updatedAt);
    }

    /// @notice Returns a hedge position record.
    function getPosition(bytes32 _positionId) external view returns (HedgePosition memory) {
        return positions[_positionId];
    }

    /// @notice Returns a business's hedge portfolio summary.
    function getPortfolio(address _hedger) external view returns (HedgePortfolio memory) {
        return portfolios[_hedger];
    }

    /// @notice Returns all position IDs for a business.
    function getBusinessPositions(address _hedger) external view returns (bytes32[] memory) {
        return businessPositions[_hedger];
    }

    /// @notice Returns the hedge effectiveness for a position.
    function getHedgeEffectiveness(bytes32 _positionId) external view returns (HedgeEffectiveness memory) {
        return hedgeEffectiveness[_positionId];
    }

    /// @notice Returns all active currency pair IDs.
    function getActivePairs() external view returns (bytes32[] memory) {
        return activePairIds;
    }

    /// @notice Returns a currency pair configuration.
    function getCurrencyPair(bytes32 _pairId) external view returns (CurrencyPair memory) {
        return currencyPairs[_pairId];
    }

    /// @notice Checks whether a position is under-margined.
    function isUnderMargined(bytes32 _positionId) external view returns (bool) {
        HedgePosition storage pos = positions[_positionId];
        if (pos.status != PositionStatus.ACTIVE) return false;

        FXRate storage currentRate = latestRates[pos.pairId];
        if (block.timestamp > currentRate.updatedAt + MAX_RATE_STALENESS) return false;

        CurrencyPair storage pair = currencyPairs[pos.pairId];
        uint256 maintenanceMargin = (pos.notionalAmount * pair.maintenanceMarginBps) / 10_000;

        uint256 unrealizedLoss;
        if (pos.hedgeType == HedgeType.FORWARD && currentRate.rate < pos.lockedRate) {
            unrealizedLoss = ((pos.lockedRate - currentRate.rate) * pos.notionalAmount) / RATE_PRECISION;
        }

        uint256 effectiveCollateral = unrealizedLoss >= pos.collateralAmount
            ? 0
            : pos.collateralAmount - unrealizedLoss;

        return effectiveCollateral < maintenanceMargin;
    }

    // ──────────────────────────────────────────────────────────────
    // Admin Functions
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Adds a new currency pair.
     * @param _baseCurrency      3-byte ISO currency code.
     * @param _quoteCurrency     3-byte ISO currency code.
     * @param _maxHedgeRatio     Maximum hedge ratio in bps.
     * @param _marginReqBps      Initial margin requirement in bps.
     * @param _maintenanceMarginBps Maintenance margin in bps.
     */
    function addCurrencyPair(
        bytes3 _baseCurrency,
        bytes3 _quoteCurrency,
        uint256 _maxHedgeRatio,
        uint256 _marginReqBps,
        uint256 _maintenanceMarginBps
    ) external onlyRole(ADMIN_ROLE) {
        bytes32 pairId = keccak256(abi.encodePacked(_baseCurrency, _quoteCurrency));
        if (currencyPairs[pairId].pairId != bytes32(0)) revert PairAlreadyExists();

        currencyPairs[pairId] = CurrencyPair({
            baseCurrency: _baseCurrency,
            quoteCurrency: _quoteCurrency,
            pairId: pairId,
            active: true,
            maxHedgeRatio: _maxHedgeRatio,
            marginRequirementBps: _marginReqBps,
            maintenanceMarginBps: _maintenanceMarginBps
        });

        activePairIds.push(pairId);

        emit CurrencyPairAdded(pairId, _baseCurrency, _quoteCurrency, _marginReqBps);
    }

    /// @notice Activates or deactivates a currency pair.
    function setCurrencyPairActive(bytes32 _pairId, bool _active) external onlyRole(ADMIN_ROLE) {
        if (currencyPairs[_pairId].pairId == bytes32(0)) revert PairNotFound();
        currencyPairs[_pairId].active = _active;
        emit CurrencyPairUpdated(_pairId, _active);
    }

    /// @notice Adds or removes a supported collateral token.
    function setSupportedCollateral(address _token, bool _supported) external onlyRole(ADMIN_ROLE) {
        if (_token == address(0)) revert ZeroAddress();
        supportedCollateral[_token] = _supported;
        emit CollateralTokenUpdated(_token, _supported);
    }

    /// @notice Updates the treasury address.
    function setTreasury(address _newTreasury) external onlyRole(ADMIN_ROLE) {
        if (_newTreasury == address(0)) revert ZeroAddress();
        address old = treasury;
        treasury = _newTreasury;
        emit TreasuryUpdated(old, _newTreasury);
    }

    /// @notice Updates the settlement fee.
    function setSettlementFee(uint256 _newFeeBps) external onlyRole(ADMIN_ROLE) {
        if (_newFeeBps > 500) revert InvalidFee();
        uint256 oldFee = settlementFeeBps;
        settlementFeeBps = _newFeeBps;
        emit SettlementFeeUpdated(oldFee, _newFeeBps);
    }

    /// @notice Emergency pause.
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    /// @notice Resume operations.
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    // ──────────────────────────────────────────────────────────────
    // Internal Helpers
    // ──────────────────────────────────────────────────────────────

    /**
     * @dev Validates common parameters for new position creation.
     */
    function _validateNewPosition(
        bytes32 _pairId,
        uint256 _notionalAmount,
        uint256 _maturityDate,
        address _collateralToken
    ) internal view {
        CurrencyPair storage pair = currencyPairs[_pairId];
        if (pair.pairId == bytes32(0)) revert PairNotFound();
        if (!pair.active) revert PairNotActive();
        if (_notionalAmount == 0) revert ZeroAmount();
        if (_maturityDate <= block.timestamp) revert MaturityInPast();
        if (_maturityDate > block.timestamp + MAX_MATURITY) revert MaturityTooFar();
        if (!supportedCollateral[_collateralToken]) revert UnsupportedCollateral();
        if (businessPositions[msg.sender].length >= MAX_POSITIONS_PER_BUSINESS) {
            revert MaxPositionsReached();
        }
    }

    /**
     * @dev Requires that an FX rate is not stale.
     */
    function _requireFreshRate(FXRate storage _rate) internal view {
        if (_rate.updatedAt == 0 || block.timestamp > _rate.updatedAt + MAX_RATE_STALENESS) {
            revert RateStale(_rate.updatedAt, MAX_RATE_STALENESS);
        }
    }
}

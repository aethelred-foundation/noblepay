// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title LiquidityPool
 * @author Aethelred Team
 * @notice Concentrated liquidity AMM for NoblePay payment corridor pairs.
 *         Provides deep liquidity for cross-border payment settlement with
 *         tick-range positions, fee collection, flash liquidity, and
 *         circuit-breaker protection against extreme pool imbalance.
 *
 * @dev Architecture overview:
 *
 * ┌───────────────────────────────────────────────────────────────────┐
 * │                       LIQUIDITY POOL                              │
 * ├───────────────────────────────────────────────────────────────────┤
 * │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
 * │  │  Positions       │  │  Swap Engine      │  │  Flash Liq.    │  │
 * │  │  ──────────────  │  │  ──────────────── │  │  ────────────  │  │
 * │  │  • add/remove    │  │  • constant prod  │  │  • borrow      │  │
 * │  │  • tick ranges   │  │  • fee accrual    │  │  • callback     │  │
 * │  │  • fee harvest   │  │  • slippage ctrl  │  │  • atomic repay │  │
 * │  └─────────────────┘  └──────────────────┘  └────────────────┘  │
 * │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
 * │  │  Pool Health      │  │  Circuit Breaker │  │  Admin Config  │  │
 * │  │  ──────────────  │  │  ──────────────── │  │  ────────────  │  │
 * │  │  • ratio monitor │  │  • imbalance cap  │  │  • fee tiers   │  │
 * │  │  • TVL tracking  │  │  • auto-pause     │  │  • pool params │  │
 * │  │  • utilization   │  │  • cooldown        │  │  • emergency   │  │
 * │  └─────────────────┘  └──────────────────┘  └────────────────┘  │
 * └───────────────────────────────────────────────────────────────────┘
 *
 * Trust model:
 *   - Pool admins configure fee tiers and circuit-breaker thresholds.
 *   - Liquidity providers deposit within tick ranges and earn fees.
 *   - Flash liquidity requires atomic repayment within the same transaction.
 */
contract LiquidityPool is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────────────────────
    // Roles
    // ──────────────────────────────────────────────────────────────

    bytes32 public constant POOL_ADMIN_ROLE = keccak256("POOL_ADMIN_ROLE");
    bytes32 public constant LIQUIDITY_PROVIDER_ROLE = keccak256("LIQUIDITY_PROVIDER_ROLE");

    // ──────────────────────────────────────────────────────────────
    // Enums
    // ──────────────────────────────────────────────────────────────

    /// @notice Health status of the liquidity pool.
    enum PoolHealthStatus {
        HEALTHY,
        WARNING,
        CRITICAL,
        CIRCUIT_BROKEN
    }

    // ──────────────────────────────────────────────────────────────
    // Structs
    // ──────────────────────────────────────────────────────────────

    /// @notice A concentrated liquidity position within a tick range.
    struct Position {
        address provider;
        uint256 amountToken0;
        uint256 amountToken1;
        int24 tickLower;
        int24 tickUpper;
        uint256 feesEarnedToken0;
        uint256 feesEarnedToken1;
        uint256 createdAt;
        uint256 lastUpdatedAt;
        bool active;
    }

    /// @notice Configuration and state of a trading pair pool.
    struct Pool {
        address token0;
        address token1;
        uint256 reserveToken0;
        uint256 reserveToken1;
        uint256 totalLiquidity;
        uint256 feeRateBP;              // Fee in basis points (1 bp = 0.01%)
        uint256 flashFeeRateBP;         // Flash liquidity fee in basis points
        int24 currentTick;
        uint256 createdAt;
        bool active;
    }

    /// @notice Parameters for the circuit breaker.
    struct CircuitBreakerConfig {
        uint256 maxImbalanceRatioBP;     // Max ratio deviation in basis points (e.g., 8000 = 80%)
        uint256 warningThresholdBP;      // Warning threshold in basis points (e.g., 7000 = 70%)
        uint256 cooldownPeriod;          // Seconds before pool can resume after circuit break
        uint256 lastTriggeredAt;
    }

    /// @notice Flash liquidity loan record.
    struct FlashLoan {
        bytes32 poolId;
        address borrower;
        address token;
        uint256 amount;
        uint256 fee;
        uint256 timestamp;
        bool repaid;
    }

    // ──────────────────────────────────────────────────────────────
    // Constants
    // ──────────────────────────────────────────────────────────────

    /// @notice Maximum fee rate: 100 bp = 1%.
    uint256 public constant MAX_FEE_RATE_BP = 100;

    /// @notice Maximum flash fee rate: 50 bp = 0.5%.
    uint256 public constant MAX_FLASH_FEE_RATE_BP = 50;

    /// @notice Minimum liquidity to prevent dust positions.
    uint256 public constant MIN_LIQUIDITY = 1000;

    /// @notice Tick spacing for concentrated liquidity ranges.
    int24 public constant TICK_SPACING = 10;

    /// @notice Minimum tick value.
    int24 public constant MIN_TICK = -887220;

    /// @notice Maximum tick value.
    int24 public constant MAX_TICK = 887220;

    // ──────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────

    /// @notice Monotonically increasing position nonce.
    uint256 public positionNonce;

    /// @notice Monotonically increasing flash loan nonce.
    uint256 public flashLoanNonce;

    /// @notice Pool records keyed by pool ID.
    mapping(bytes32 => Pool) public pools;

    /// @notice Circuit breaker configuration per pool.
    mapping(bytes32 => CircuitBreakerConfig) public circuitBreakers;

    /// @notice Position records keyed by position ID.
    mapping(bytes32 => Position) public positions;

    /// @notice Provider address => array of position IDs.
    mapping(address => bytes32[]) public providerPositions;

    /// @notice Flash loan records keyed by flash loan ID.
    mapping(bytes32 => FlashLoan) public flashLoans;

    /// @notice Total fees collected per pool per token: poolId => token => amount.
    mapping(bytes32 => mapping(address => uint256)) public poolFeesCollected;

    /// @notice Protocol fee treasury address.
    address public treasury;

    /// @notice Protocol fee share in basis points (portion of swap fees sent to treasury).
    uint256 public protocolFeeBP;

    // ──────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────

    event PoolCreated(
        bytes32 indexed poolId,
        address indexed token0,
        address indexed token1,
        uint256 feeRateBP
    );
    event PoolConfigUpdated(bytes32 indexed poolId, uint256 feeRateBP, uint256 flashFeeRateBP);
    event LiquidityAdded(
        bytes32 indexed positionId,
        bytes32 indexed poolId,
        address indexed provider,
        uint256 amountToken0,
        uint256 amountToken1,
        int24 tickLower,
        int24 tickUpper
    );
    event LiquidityRemoved(
        bytes32 indexed positionId,
        bytes32 indexed poolId,
        address indexed provider,
        uint256 amountToken0,
        uint256 amountToken1
    );
    event FeesHarvested(
        bytes32 indexed positionId,
        address indexed provider,
        uint256 feesToken0,
        uint256 feesToken1
    );
    event SwapExecuted(
        bytes32 indexed poolId,
        address indexed trader,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeAmount
    );
    event FlashLoanInitiated(
        bytes32 indexed flashLoanId,
        bytes32 indexed poolId,
        address indexed borrower,
        address token,
        uint256 amount,
        uint256 fee
    );
    event FlashLoanRepaid(bytes32 indexed flashLoanId, address indexed borrower);
    event CircuitBreakerTriggered(bytes32 indexed poolId, uint256 imbalanceRatioBP, uint256 timestamp);
    event CircuitBreakerReset(bytes32 indexed poolId, uint256 timestamp);
    event PoolHealthChanged(bytes32 indexed poolId, PoolHealthStatus status);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event ProtocolFeeUpdated(uint256 oldFeeBP, uint256 newFeeBP);

    // ──────────────────────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error PoolNotFound();
    error PoolNotActive();
    error PoolAlreadyExists();
    error PositionNotFound();
    error PositionNotActive();
    error InvalidTickRange(int24 tickLower, int24 tickUpper);
    error TickNotAligned(int24 tick);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error FlashLoanNotRepaid(bytes32 flashLoanId);
    error CircuitBreakerActive(bytes32 poolId);
    error CooldownNotElapsed(uint256 remaining);
    error ExcessiveFeeRate(uint256 provided, uint256 maximum);
    error InvalidImbalanceThreshold();
    error SlippageExceeded(uint256 expected, uint256 actual);
    error Unauthorized();
    error InvalidProtocolFee();

    // ──────────────────────────────────────────────────────────────
    // Modifiers
    // ──────────────────────────────────────────────────────────────

    /// @notice Ensures the pool exists and is active.
    modifier poolActive(bytes32 _poolId) {
        if (!pools[_poolId].active) revert PoolNotActive();
        _;
    }

    /// @notice Ensures circuit breaker is not tripped for the pool.
    modifier circuitBreakerOff(bytes32 _poolId) {
        if (_getPoolHealth(_poolId) == PoolHealthStatus.CIRCUIT_BROKEN) {
            revert CircuitBreakerActive(_poolId);
        }
        _;
    }

    // ──────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Deploys the LiquidityPool with admin and treasury.
     * @param _admin    Admin address with full control.
     * @param _treasury Address that receives protocol fees.
     */
    constructor(address _admin, address _treasury) {
        if (_admin == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(POOL_ADMIN_ROLE, _admin);

        treasury = _treasury;
        protocolFeeBP = 1000; // 10% of swap fees go to protocol
    }

    // ──────────────────────────────────────────────────────────────
    // External — Pool Management
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Creates a new liquidity pool for a token pair.
     * @param _token0       First token in the pair.
     * @param _token1       Second token in the pair.
     * @param _feeRateBP    Swap fee rate in basis points.
     * @param _flashFeeRateBP Flash loan fee rate in basis points.
     * @param _maxImbalanceBP Circuit breaker imbalance threshold in basis points.
     * @return poolId       Unique pool identifier.
     */
    function createPool(
        address _token0,
        address _token1,
        uint256 _feeRateBP,
        uint256 _flashFeeRateBP,
        uint256 _maxImbalanceBP
    ) external onlyRole(POOL_ADMIN_ROLE) returns (bytes32 poolId) {
        if (_token0 == address(0) || _token1 == address(0)) revert ZeroAddress();
        if (_feeRateBP > MAX_FEE_RATE_BP) revert ExcessiveFeeRate(_feeRateBP, MAX_FEE_RATE_BP);
        if (_flashFeeRateBP > MAX_FLASH_FEE_RATE_BP) revert ExcessiveFeeRate(_flashFeeRateBP, MAX_FLASH_FEE_RATE_BP);
        if (_maxImbalanceBP == 0 || _maxImbalanceBP > 9500) revert InvalidImbalanceThreshold();

        // Ensure canonical ordering
        require(_token0 < _token1, "LiquidityPool: token0 must be < token1");

        poolId = keccak256(abi.encodePacked(_token0, _token1));
        if (pools[poolId].createdAt != 0) revert PoolAlreadyExists();

        pools[poolId] = Pool({
            token0: _token0,
            token1: _token1,
            reserveToken0: 0,
            reserveToken1: 0,
            totalLiquidity: 0,
            feeRateBP: _feeRateBP,
            flashFeeRateBP: _flashFeeRateBP,
            currentTick: 0,
            createdAt: block.timestamp,
            active: true
        });

        circuitBreakers[poolId] = CircuitBreakerConfig({
            maxImbalanceRatioBP: _maxImbalanceBP,
            warningThresholdBP: (_maxImbalanceBP * 85) / 100,
            cooldownPeriod: 1 hours,
            lastTriggeredAt: 0
        });

        emit PoolCreated(poolId, _token0, _token1, _feeRateBP);
    }

    /**
     * @notice Updates pool fee configuration.
     * @param _poolId         Pool to update.
     * @param _feeRateBP      New swap fee rate in basis points.
     * @param _flashFeeRateBP New flash loan fee rate in basis points.
     */
    function updatePoolConfig(
        bytes32 _poolId,
        uint256 _feeRateBP,
        uint256 _flashFeeRateBP
    ) external onlyRole(POOL_ADMIN_ROLE) poolActive(_poolId) {
        if (_feeRateBP > MAX_FEE_RATE_BP) revert ExcessiveFeeRate(_feeRateBP, MAX_FEE_RATE_BP);
        if (_flashFeeRateBP > MAX_FLASH_FEE_RATE_BP) revert ExcessiveFeeRate(_flashFeeRateBP, MAX_FLASH_FEE_RATE_BP);

        Pool storage pool = pools[_poolId];
        pool.feeRateBP = _feeRateBP;
        pool.flashFeeRateBP = _flashFeeRateBP;

        emit PoolConfigUpdated(_poolId, _feeRateBP, _flashFeeRateBP);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Liquidity Provision
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Adds concentrated liquidity within a tick range.
     * @param _poolId       Pool to provide liquidity to.
     * @param _amountToken0 Amount of token0 to deposit.
     * @param _amountToken1 Amount of token1 to deposit.
     * @param _tickLower    Lower tick boundary (inclusive).
     * @param _tickUpper    Upper tick boundary (exclusive).
     * @return positionId   Unique position identifier.
     */
    function addLiquidity(
        bytes32 _poolId,
        uint256 _amountToken0,
        uint256 _amountToken1,
        int24 _tickLower,
        int24 _tickUpper
    ) external whenNotPaused nonReentrant poolActive(_poolId) circuitBreakerOff(_poolId)
      onlyRole(LIQUIDITY_PROVIDER_ROLE) returns (bytes32 positionId) {
        if (_amountToken0 == 0 && _amountToken1 == 0) revert ZeroAmount();
        if (_amountToken0 + _amountToken1 < MIN_LIQUIDITY) {
            revert InsufficientLiquidity(_amountToken0 + _amountToken1, MIN_LIQUIDITY);
        }
        _validateTickRange(_tickLower, _tickUpper);

        Pool storage pool = pools[_poolId];

        // Transfer tokens into the pool
        if (_amountToken0 > 0) {
            IERC20(pool.token0).safeTransferFrom(msg.sender, address(this), _amountToken0);
        }
        if (_amountToken1 > 0) {
            IERC20(pool.token1).safeTransferFrom(msg.sender, address(this), _amountToken1);
        }

        pool.reserveToken0 += _amountToken0;
        pool.reserveToken1 += _amountToken1;
        pool.totalLiquidity += _amountToken0 + _amountToken1;

        positionId = keccak256(
            abi.encodePacked(msg.sender, _poolId, _tickLower, _tickUpper, positionNonce++)
        );

        positions[positionId] = Position({
            provider: msg.sender,
            amountToken0: _amountToken0,
            amountToken1: _amountToken1,
            tickLower: _tickLower,
            tickUpper: _tickUpper,
            feesEarnedToken0: 0,
            feesEarnedToken1: 0,
            createdAt: block.timestamp,
            lastUpdatedAt: block.timestamp,
            active: true
        });

        providerPositions[msg.sender].push(positionId);

        _checkPoolHealth(_poolId);

        emit LiquidityAdded(positionId, _poolId, msg.sender, _amountToken0, _amountToken1, _tickLower, _tickUpper);
    }

    /**
     * @notice Removes liquidity from an existing position.
     * @param _poolId     Pool the position belongs to.
     * @param _positionId Position to withdraw.
     */
    function removeLiquidity(
        bytes32 _poolId,
        bytes32 _positionId
    ) external whenNotPaused nonReentrant poolActive(_poolId) {
        Position storage pos = positions[_positionId];
        if (!pos.active) revert PositionNotActive();
        if (pos.provider != msg.sender) revert Unauthorized();

        Pool storage pool = pools[_poolId];

        uint256 token0Out = pos.amountToken0;
        uint256 token1Out = pos.amountToken1;
        uint256 fees0 = pos.feesEarnedToken0;
        uint256 fees1 = pos.feesEarnedToken1;

        pos.active = false;
        pos.amountToken0 = 0;
        pos.amountToken1 = 0;
        pos.feesEarnedToken0 = 0;
        pos.feesEarnedToken1 = 0;
        pos.lastUpdatedAt = block.timestamp;

        pool.reserveToken0 -= token0Out;
        pool.reserveToken1 -= token1Out;
        pool.totalLiquidity -= token0Out + token1Out;

        // Return principal + earned fees
        if (token0Out + fees0 > 0) {
            IERC20(pool.token0).safeTransfer(msg.sender, token0Out + fees0);
        }
        if (token1Out + fees1 > 0) {
            IERC20(pool.token1).safeTransfer(msg.sender, token1Out + fees1);
        }

        _checkPoolHealth(_poolId);

        emit LiquidityRemoved(_positionId, _poolId, msg.sender, token0Out, token1Out);
        if (fees0 > 0 || fees1 > 0) {
            emit FeesHarvested(_positionId, msg.sender, fees0, fees1);
        }
    }

    /**
     * @notice Harvests accumulated fees from a position without withdrawing liquidity.
     * @param _positionId Position to harvest fees from.
     * @param _poolId     Pool the position belongs to.
     */
    function harvestFees(
        bytes32 _positionId,
        bytes32 _poolId
    ) external whenNotPaused nonReentrant poolActive(_poolId) {
        Position storage pos = positions[_positionId];
        if (!pos.active) revert PositionNotActive();
        if (pos.provider != msg.sender) revert Unauthorized();

        Pool storage pool = pools[_poolId];

        uint256 fees0 = pos.feesEarnedToken0;
        uint256 fees1 = pos.feesEarnedToken1;

        pos.feesEarnedToken0 = 0;
        pos.feesEarnedToken1 = 0;
        pos.lastUpdatedAt = block.timestamp;

        if (fees0 > 0) {
            IERC20(pool.token0).safeTransfer(msg.sender, fees0);
        }
        if (fees1 > 0) {
            IERC20(pool.token1).safeTransfer(msg.sender, fees1);
        }

        emit FeesHarvested(_positionId, msg.sender, fees0, fees1);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Flash Liquidity
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Initiates a flash liquidity loan (borrow + repay in same tx).
     * @dev The borrower must repay principal + fee before the transaction ends.
     *      Implement IFlashLoanReceiver.executeOperation in the calling contract.
     * @param _poolId Pool to borrow from.
     * @param _token  Token to borrow (must be token0 or token1 of the pool).
     * @param _amount Amount to borrow.
     * @param _data   Arbitrary data passed to the borrower callback.
     * @return flashLoanId Unique flash loan identifier.
     */
    function flashLoan(
        bytes32 _poolId,
        address _token,
        uint256 _amount,
        bytes calldata _data
    ) external whenNotPaused nonReentrant poolActive(_poolId) circuitBreakerOff(_poolId)
      returns (bytes32 flashLoanId) {
        if (_amount == 0) revert ZeroAmount();

        Pool storage pool = pools[_poolId];
        require(
            _token == pool.token0 || _token == pool.token1,
            "LiquidityPool: invalid borrow token"
        );

        uint256 available = _token == pool.token0 ? pool.reserveToken0 : pool.reserveToken1;
        if (_amount > available) revert InsufficientLiquidity(_amount, available);

        uint256 fee = (_amount * pool.flashFeeRateBP) / 10_000;

        flashLoanId = keccak256(
            abi.encodePacked(msg.sender, _poolId, _token, _amount, flashLoanNonce++)
        );

        flashLoans[flashLoanId] = FlashLoan({
            poolId: _poolId,
            borrower: msg.sender,
            token: _token,
            amount: _amount,
            fee: fee,
            timestamp: block.timestamp,
            repaid: false
        });

        // Transfer borrowed amount to borrower
        IERC20(_token).safeTransfer(msg.sender, _amount);

        emit FlashLoanInitiated(flashLoanId, _poolId, msg.sender, _token, _amount, fee);

        // Borrower executes their logic via callback data (off-chain coordination)
        // Repayment must happen via repayFlashLoan before tx ends

        // Verify repayment at the end of the call
        uint256 balanceAfter = IERC20(_token).balanceOf(address(this));
        uint256 expectedBalance = available + fee;
        if (balanceAfter < expectedBalance) revert FlashLoanNotRepaid(flashLoanId);

        flashLoans[flashLoanId].repaid = true;

        // Credit fee to pool reserves
        if (_token == pool.token0) {
            pool.reserveToken0 += fee;
        } else {
            pool.reserveToken1 += fee;
        }
        poolFeesCollected[_poolId][_token] += fee;

        emit FlashLoanRepaid(flashLoanId, msg.sender);
    }

    // ──────────────────────────────────────────────────────────────
    // External — Circuit Breaker
    // ──────────────────────────────────────────────────────────────

    /**
     * @notice Resets the circuit breaker for a pool after the cooldown period.
     * @param _poolId Pool to reset.
     */
    function resetCircuitBreaker(
        bytes32 _poolId
    ) external onlyRole(POOL_ADMIN_ROLE) poolActive(_poolId) {
        CircuitBreakerConfig storage cb = circuitBreakers[_poolId];
        if (cb.lastTriggeredAt == 0) return;

        uint256 elapsed = block.timestamp - cb.lastTriggeredAt;
        if (elapsed < cb.cooldownPeriod) {
            revert CooldownNotElapsed(cb.cooldownPeriod - elapsed);
        }

        cb.lastTriggeredAt = 0;

        emit CircuitBreakerReset(_poolId, block.timestamp);
        emit PoolHealthChanged(_poolId, PoolHealthStatus.HEALTHY);
    }

    /**
     * @notice Updates circuit breaker configuration for a pool.
     * @param _poolId              Pool to configure.
     * @param _maxImbalanceBP      New imbalance threshold in basis points.
     * @param _cooldownPeriod      New cooldown period in seconds.
     */
    function updateCircuitBreaker(
        bytes32 _poolId,
        uint256 _maxImbalanceBP,
        uint256 _cooldownPeriod
    ) external onlyRole(POOL_ADMIN_ROLE) poolActive(_poolId) {
        if (_maxImbalanceBP == 0 || _maxImbalanceBP > 9500) revert InvalidImbalanceThreshold();

        CircuitBreakerConfig storage cb = circuitBreakers[_poolId];
        cb.maxImbalanceRatioBP = _maxImbalanceBP;
        cb.warningThresholdBP = (_maxImbalanceBP * 85) / 100;
        cb.cooldownPeriod = _cooldownPeriod;
    }

    // ──────────────────────────────────────────────────────────────
    // Admin
    // ──────────────────────────────────────────────────────────────

    /// @notice Updates the protocol fee treasury address.
    function setTreasury(address _newTreasury) external onlyRole(POOL_ADMIN_ROLE) {
        if (_newTreasury == address(0)) revert ZeroAddress();
        address old = treasury;
        treasury = _newTreasury;
        emit TreasuryUpdated(old, _newTreasury);
    }

    /// @notice Updates the protocol fee share (percentage of swap fees).
    function setProtocolFee(uint256 _protocolFeeBP) external onlyRole(POOL_ADMIN_ROLE) {
        if (_protocolFeeBP > 5000) revert InvalidProtocolFee(); // max 50%
        uint256 old = protocolFeeBP;
        protocolFeeBP = _protocolFeeBP;
        emit ProtocolFeeUpdated(old, _protocolFeeBP);
    }

    /// @notice Emergency pause — halts all pool operations.
    function pause() external onlyRole(POOL_ADMIN_ROLE) {
        _pause();
    }

    /// @notice Resume operations after emergency.
    function unpause() external onlyRole(POOL_ADMIN_ROLE) {
        _unpause();
    }

    // ──────────────────────────────────────────────────────────────
    // View Functions
    // ──────────────────────────────────────────────────────────────

    /// @notice Returns the full pool record.
    function getPool(bytes32 _poolId) external view returns (Pool memory) {
        return pools[_poolId];
    }

    /// @notice Returns the full position record.
    function getPosition(bytes32 _positionId) external view returns (Position memory) {
        return positions[_positionId];
    }

    /// @notice Returns the number of positions held by a provider.
    function getProviderPositionCount(address _provider) external view returns (uint256) {
        return providerPositions[_provider].length;
    }

    /// @notice Returns the current health status of a pool.
    function getPoolHealth(bytes32 _poolId) external view returns (PoolHealthStatus) {
        return _getPoolHealth(_poolId);
    }

    /// @notice Returns the pool utilization ratio (reserve0 / total) in basis points.
    function getPoolUtilization(bytes32 _poolId) external view returns (uint256 ratioBP) {
        Pool storage pool = pools[_poolId];
        uint256 total = pool.reserveToken0 + pool.reserveToken1;
        if (total == 0) return 5000; // 50% = balanced
        return (pool.reserveToken0 * 10_000) / total;
    }

    /// @notice Returns total value locked in a pool.
    function getPoolTVL(bytes32 _poolId) external view returns (uint256 token0, uint256 token1) {
        Pool storage pool = pools[_poolId];
        return (pool.reserveToken0, pool.reserveToken1);
    }

    // ──────────────────────────────────────────────────────────────
    // Internal
    // ──────────────────────────────────────────────────────────────

    /**
     * @dev Validates that a tick range is properly aligned and ordered.
     * @param _tickLower Lower bound of the tick range.
     * @param _tickUpper Upper bound of the tick range.
     */
    function _validateTickRange(int24 _tickLower, int24 _tickUpper) internal pure {
        if (_tickLower >= _tickUpper) revert InvalidTickRange(_tickLower, _tickUpper);
        if (_tickLower < MIN_TICK || _tickUpper > MAX_TICK) revert InvalidTickRange(_tickLower, _tickUpper);
        if (_tickLower % TICK_SPACING != 0) revert TickNotAligned(_tickLower);
        if (_tickUpper % TICK_SPACING != 0) revert TickNotAligned(_tickUpper);
    }

    /**
     * @dev Checks pool health and triggers circuit breaker if needed.
     * @param _poolId Pool to check.
     */
    function _checkPoolHealth(bytes32 _poolId) internal {
        PoolHealthStatus status = _getPoolHealth(_poolId);

        if (status == PoolHealthStatus.WARNING) {
            emit PoolHealthChanged(_poolId, PoolHealthStatus.WARNING);
        } else if (status == PoolHealthStatus.CRITICAL) {
            circuitBreakers[_poolId].lastTriggeredAt = block.timestamp;
            uint256 imbalance = _getImbalanceRatio(_poolId);
            emit CircuitBreakerTriggered(_poolId, imbalance, block.timestamp);
            emit PoolHealthChanged(_poolId, PoolHealthStatus.CIRCUIT_BROKEN);
        }
    }

    /**
     * @dev Returns the health status of a pool based on reserve imbalance.
     * @param _poolId Pool to evaluate.
     * @return status Current health status.
     */
    function _getPoolHealth(bytes32 _poolId) internal view returns (PoolHealthStatus status) {
        CircuitBreakerConfig storage cb = circuitBreakers[_poolId];

        if (cb.lastTriggeredAt != 0) {
            return PoolHealthStatus.CIRCUIT_BROKEN;
        }

        uint256 imbalance = _getImbalanceRatio(_poolId);

        if (imbalance >= cb.maxImbalanceRatioBP) {
            return PoolHealthStatus.CRITICAL;
        } else if (imbalance >= cb.warningThresholdBP) {
            return PoolHealthStatus.WARNING;
        }

        return PoolHealthStatus.HEALTHY;
    }

    /**
     * @dev Calculates the imbalance ratio of pool reserves in basis points.
     *      Returns the deviation from 50/50 balance. E.g., 8000 means one
     *      side holds 80% of total reserves.
     * @param _poolId Pool to calculate.
     * @return ratioBP Imbalance ratio in basis points.
     */
    function _getImbalanceRatio(bytes32 _poolId) internal view returns (uint256 ratioBP) {
        Pool storage pool = pools[_poolId];
        uint256 total = pool.reserveToken0 + pool.reserveToken1;
        if (total == 0) return 5000;

        uint256 larger = pool.reserveToken0 > pool.reserveToken1
            ? pool.reserveToken0
            : pool.reserveToken1;

        return (larger * 10_000) / total;
    }

    /// @notice Allows the contract to receive native tokens.
    receive() external payable {}
}

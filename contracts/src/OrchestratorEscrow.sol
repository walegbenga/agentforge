// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IAgentCapabilityRegistry {
    function recordJobCompletion(address agentWallet, uint256 earnedAmount) external;
}

/**
 * @title OrchestratorEscrow
 * @notice Master escrow contract for AgentForge.
 *
 *  Flow:
 *  1. User calls createTask() with USDC budget → funds locked in escrow
 *  2. Backend orchestrator calls assignSubtask() per subtask → reserves USDC per agent
 *  3. Agent submits deliverable hash → submitDeliverable()
 *  4. Orchestrator evaluates → settleSubtask() (release) or disputeSubtask() (refund)
 *  5. After all subtasks complete → completeTask() releases remainder to platform
 *
 *  USDC contract on Arc Testnet: 0x3600000000000000000000000000000000000000
 */
contract OrchestratorEscrow is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /**
     * @dev Multiple wallets can hold ORCHESTRATOR_ROLE simultaneously —
     * this is what lets assignSubtask/settleSubtask/disputeSubtask/
     * completeTask be signed by a POOL of operator wallets in parallel
     * instead of a single address's sequential nonce being the ceiling on
     * platform throughput. DEFAULT_ADMIN_ROLE (see AccessControl) is what
     * can grant/revoke this role and is held only by the deployer/admin —
     * never grant ORCHESTRATOR_ROLE to anyone who shouldn't be able to
     * decide payouts, since that's exactly what this role authorizes.
     */
    bytes32 public constant ORCHESTRATOR_ROLE = keccak256("ORCHESTRATOR_ROLE");

    // ── Constants ─────────────────────────────────────────────────────────────

    IERC20 public immutable USDC;
    IAgentCapabilityRegistry public immutable registry;

    uint256 public platformFeeBps = 200; // 2% platform fee
    address public feeRecipient;

    uint256 public constant MAX_SUBTASKS = 20;
    uint256 public constant TASK_EXPIRY = 24 hours;

    // ── Enums ─────────────────────────────────────────────────────────────────

    enum TaskStatus    { Active, Completed, Cancelled }
    enum SubtaskStatus { Pending, Assigned, Submitted, Settled, Disputed }

    // ── Structs ───────────────────────────────────────────────────────────────

    struct Subtask {
        uint256   taskId;
        uint256   subtaskIndex;
        address   agentWallet;
        bytes32   capability;
        uint256   budget;          // USDC (6 decimals)
        bytes32   deliverableHash;
        string    description;
        SubtaskStatus status;
        uint256   assignedAt;
        uint256   settledAt;
    }

    struct Task {
        uint256   id;
        address   requester;
        string    description;
        uint256   totalBudget;     // USDC deposited
        uint256   allocatedBudget; // sum of subtask budgets
        uint256   subtaskCount;
        uint256   settledCount;
        TaskStatus status;
        uint256   createdAt;
        uint256   expiresAt;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    uint256 public nextTaskId = 1;
    mapping(uint256 => Task) public tasks;
    mapping(uint256 => mapping(uint256 => Subtask)) public subtasks; // taskId → index → Subtask

    // ── Events ────────────────────────────────────────────────────────────────

    event TaskCreated(uint256 indexed taskId, address indexed requester, uint256 budget);
    event SubtaskAssigned(uint256 indexed taskId, uint256 indexed subtaskIndex, address agent, uint256 budget);
    event DeliverableSubmitted(uint256 indexed taskId, uint256 indexed subtaskIndex, bytes32 deliverableHash);
    event SubtaskSettled(uint256 indexed taskId, uint256 indexed subtaskIndex, address agent, uint256 amount, uint256 completionBps);
    event SubtaskDisputed(uint256 indexed taskId, uint256 indexed subtaskIndex);
    event TaskCompleted(uint256 indexed taskId);
    event TaskCancelled(uint256 indexed taskId, uint256 refundAmount);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(
        address usdcAddress,
        address registryAddress,
        address _feeRecipient,
        address[] memory initialOrchestrators
    ) {
        USDC = IERC20(usdcAddress);
        registry = IAgentCapabilityRegistry(registryAddress);
        feeRecipient = _feeRecipient;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ORCHESTRATOR_ROLE, msg.sender); // deployer works out of the box as a single signer

        for (uint256 i = 0; i < initialOrchestrators.length; i++) {
            _grantRole(ORCHESTRATOR_ROLE, initialOrchestrators[i]);
        }
    }

    // ── User-facing ───────────────────────────────────────────────────────────

    /**
     * @notice Submit a task with USDC budget. User must approve() first.
     * @param description Natural language task description
     * @param budget USDC amount (6 decimals) to lock in escrow
     */
    function createTask(string calldata description, uint256 budget)
        external nonReentrant returns (uint256 taskId)
    {
        require(budget > 0, "Budget required");
        require(bytes(description).length > 0, "Description required");

        USDC.safeTransferFrom(msg.sender, address(this), budget);

        taskId = nextTaskId++;
        tasks[taskId] = Task({
            id: taskId,
            requester: msg.sender,
            description: description,
            totalBudget: budget,
            allocatedBudget: 0,
            subtaskCount: 0,
            settledCount: 0,
            status: TaskStatus.Active,
            createdAt: block.timestamp,
            expiresAt: block.timestamp + TASK_EXPIRY
        });

        emit TaskCreated(taskId, msg.sender, budget);
    }

    // ── Orchestrator-facing (backend service) ─────────────────────────────────

    /**
     * @notice Assign a subtask to a specific agent, reserving USDC
     * @dev Called by the backend orchestrator service (owner)
     */
    function assignSubtask(
        uint256 taskId,
        address agentWallet,
        bytes32 capability,
        uint256 budget,
        string calldata description
    ) external onlyRole(ORCHESTRATOR_ROLE) nonReentrant {
        Task storage task = tasks[taskId];
        require(task.status == TaskStatus.Active, "Task not active");
        require(task.subtaskCount < MAX_SUBTASKS, "Max subtasks reached");
        require(task.allocatedBudget + budget <= task.totalBudget, "Exceeds budget");
        require(block.timestamp < task.expiresAt, "Task expired");

        uint256 index = task.subtaskCount;
        subtasks[taskId][index] = Subtask({
            taskId: taskId,
            subtaskIndex: index,
            agentWallet: agentWallet,
            capability: capability,
            budget: budget,
            deliverableHash: bytes32(0),
            description: description,
            status: SubtaskStatus.Assigned,
            assignedAt: block.timestamp,
            settledAt: 0
        });

        task.subtaskCount++;
        task.allocatedBudget += budget;

        emit SubtaskAssigned(taskId, index, agentWallet, budget);
    }

    /**
     * @notice Agent submits deliverable hash for their subtask
     */
    function submitDeliverable(
        uint256 taskId,
        uint256 subtaskIndex,
        bytes32 deliverableHash
    ) external nonReentrant {
        Subtask storage subtask = subtasks[taskId][subtaskIndex];
        require(subtask.agentWallet == msg.sender, "Not assigned agent");
        require(subtask.status == SubtaskStatus.Assigned, "Wrong status");
        require(deliverableHash != bytes32(0), "Empty deliverable");

        subtask.deliverableHash = deliverableHash;
        subtask.status = SubtaskStatus.Submitted;

        emit DeliverableSubmitted(taskId, subtaskIndex, deliverableHash);
    }

    /**
     * @notice Orchestrator approves subtask → releases USDC to agent
     */
    /**
     * @notice Settle a subtask, paying the agent a fraction of its budget
     * proportional to completionBps (basis points, 0-10000). 10000 = fully
     * complete, pays the full budget minus fee — identical to the old
     * behavior. Anything below 10000 pays that fraction and frees the
     * remainder back to the task's unallocated budget (same mechanism as
     * a dispute), so a partially-complete submission doesn't lock up
     * money that was never earned.
     */
    function settleSubtask(uint256 taskId, uint256 subtaskIndex, uint256 completionBps)
        external onlyRole(ORCHESTRATOR_ROLE) nonReentrant
    {
        require(completionBps > 0 && completionBps <= 10000, "Invalid completion bps");

        Subtask storage subtask = subtasks[taskId][subtaskIndex];
        require(subtask.status == SubtaskStatus.Submitted, "Not submitted");

        Task storage task = tasks[taskId];

        uint256 payoutAmount = (subtask.budget * completionBps) / 10000;
        uint256 fee = (payoutAmount * platformFeeBps) / 10000;
        uint256 agentPayout = payoutAmount - fee;
        uint256 unpaidRemainder = subtask.budget - payoutAmount;

        subtask.status = SubtaskStatus.Settled;
        subtask.settledAt = block.timestamp;
        task.settledCount++;

        // Anything not paid out (partial completion) frees back to the
        // task's unallocated pool, same as disputeSubtask does with the
        // full amount — it gets refunded to the requester on completion.
        if (unpaidRemainder > 0) {
            task.allocatedBudget -= unpaidRemainder;
        }

        // Pay agent
        if (agentPayout > 0) {
            USDC.safeTransfer(subtask.agentWallet, agentPayout);
        }

        // Pay platform fee
        if (fee > 0) {
            USDC.safeTransfer(feeRecipient, fee);
        }

        // Update on-chain stats
        try registry.recordJobCompletion(subtask.agentWallet, agentPayout) {} catch {}

        emit SubtaskSettled(taskId, subtaskIndex, subtask.agentWallet, agentPayout, completionBps);

        // Auto-complete task if all subtasks settled
        if (task.settledCount == task.subtaskCount) {
            _completeTask(taskId);
        }
    }

    /**
     * @notice Orchestrator disputes subtask → refunds budget to task pool
     */
    function disputeSubtask(uint256 taskId, uint256 subtaskIndex)
        external onlyRole(ORCHESTRATOR_ROLE) nonReentrant
    {
        Subtask storage subtask = subtasks[taskId][subtaskIndex];
        require(
            subtask.status == SubtaskStatus.Assigned ||
            subtask.status == SubtaskStatus.Submitted,
            "Cannot dispute"
        );

        Task storage task = tasks[taskId];
        task.allocatedBudget -= subtask.budget;
        subtask.status = SubtaskStatus.Disputed;

        emit SubtaskDisputed(taskId, subtaskIndex);
    }

    /**
     * @notice Mark task complete and refund any unallocated budget
     */
    function completeTask(uint256 taskId) external onlyRole(ORCHESTRATOR_ROLE) nonReentrant {
        _completeTask(taskId);
    }

    /**
     * @notice Cancel a task and refund remaining budget to requester
     */
    function cancelTask(uint256 taskId) external nonReentrant {
        Task storage task = tasks[taskId];
        require(task.requester == msg.sender || hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "Unauthorized");
        require(task.status == TaskStatus.Active, "Not active");

        uint256 refund = task.totalBudget - _settledAmount(taskId);
        task.status = TaskStatus.Cancelled;

        if (refund > 0) {
            USDC.safeTransfer(task.requester, refund);
        }

        emit TaskCancelled(taskId, refund);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getTask(uint256 taskId) external view returns (Task memory) {
        return tasks[taskId];
    }

    function getSubtask(uint256 taskId, uint256 index) external view returns (Subtask memory) {
        return subtasks[taskId][index];
    }

    function getSubtasks(uint256 taskId) external view returns (Subtask[] memory) {
        uint256 count = tasks[taskId].subtaskCount;
        Subtask[] memory result = new Subtask[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = subtasks[taskId][i];
        }
        return result;
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setPlatformFee(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(bps <= 500, "Max 5%");
        platformFeeBps = bps;
    }

    function setFeeRecipient(address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        feeRecipient = recipient;
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _completeTask(uint256 taskId) internal {
        Task storage task = tasks[taskId];
        require(task.status == TaskStatus.Active, "Not active");

        task.status = TaskStatus.Completed;

        // Refund unallocated budget
        uint256 unallocated = task.totalBudget - task.allocatedBudget;
        if (unallocated > 0) {
            USDC.safeTransfer(task.requester, unallocated);
        }

        emit TaskCompleted(taskId);
    }

    function _settledAmount(uint256 taskId) internal view returns (uint256 total) {
        uint256 count = tasks[taskId].subtaskCount;
        for (uint256 i = 0; i < count; i++) {
            Subtask storage s = subtasks[taskId][i];
            if (s.status == SubtaskStatus.Settled) {
                total += s.budget;
            }
        }
    }
}

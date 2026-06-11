// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AgentCapabilityRegistry
 * @notice Registers AI agents with their capabilities, pricing, and links to ERC-8004 identity.
 *         Works alongside Arc's native IdentityRegistry (ERC-8004) and ReputationRegistry.
 */
contract AgentCapabilityRegistry is Ownable, ReentrancyGuard {

    // ── Structs ────────────────────────────────────────────────────────────────

    struct Agent {
        address wallet;           // Circle Developer-Controlled Wallet address
        uint256 erc8004AgentId;   // Token ID in Arc's IdentityRegistry
        string  name;
        string  description;
        string  metadataURI;      // IPFS: capabilities, model info, etc.
        bytes32[] capabilities;   // keccak256 of capability strings
        uint256 pricePerTask;     // USDC (6 decimals) base price per task
        uint256 totalJobsCompleted;
        uint256 totalEarned;      // USDC (6 decimals)
        bool    active;
        uint256 registeredAt;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    mapping(address => Agent) public agents;
    mapping(address => bool)  public isRegistered;
    mapping(bytes32 => address[]) private capabilityIndex; // capability → agents

    address[] public allAgents;

    uint256 public constant MAX_CAPABILITIES = 10;
    uint256 public constant MIN_PRICE = 100; // 0.0001 USDC minimum

    // ── Events ────────────────────────────────────────────────────────────────

    event AgentRegistered(address indexed wallet, uint256 erc8004AgentId, string name);
    event AgentUpdated(address indexed wallet);
    event AgentDeactivated(address indexed wallet);
    event AgentStatsUpdated(address indexed wallet, uint256 jobsCompleted, uint256 totalEarned);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor() Ownable(msg.sender) {}

    // ── External ──────────────────────────────────────────────────────────────

    /**
     * @notice Register a new AI agent
     * @param erc8004AgentId Token ID from Arc's ERC-8004 IdentityRegistry
     * @param name Human-readable agent name
     * @param description What this agent does
     * @param metadataURI IPFS URI with full agent spec
     * @param capabilities Array of capability hashes (keccak256 of strings like "data-analysis")
     * @param pricePerTask Base USDC price per task (6 decimals)
     */
    function registerAgent(
        uint256 erc8004AgentId,
        string calldata name,
        string calldata description,
        string calldata metadataURI,
        bytes32[] calldata capabilities,
        uint256 pricePerTask
    ) external nonReentrant {
        require(!isRegistered[msg.sender], "Already registered");
        require(bytes(name).length > 0 && bytes(name).length <= 64, "Invalid name");
        require(capabilities.length > 0 && capabilities.length <= MAX_CAPABILITIES, "Invalid capabilities");
        require(pricePerTask >= MIN_PRICE, "Price too low");

        agents[msg.sender] = Agent({
            wallet: msg.sender,
            erc8004AgentId: erc8004AgentId,
            name: name,
            description: description,
            metadataURI: metadataURI,
            capabilities: capabilities,
            pricePerTask: pricePerTask,
            totalJobsCompleted: 0,
            totalEarned: 0,
            active: true,
            registeredAt: block.timestamp
        });

        isRegistered[msg.sender] = true;
        allAgents.push(msg.sender);

        // Index by capability for efficient lookup
        for (uint256 i = 0; i < capabilities.length; i++) {
            capabilityIndex[capabilities[i]].push(msg.sender);
        }

        emit AgentRegistered(msg.sender, erc8004AgentId, name);
    }

    /**
     * @notice Update agent pricing and metadata
     */
    function updateAgent(
        string calldata metadataURI,
        uint256 pricePerTask
    ) external {
        require(isRegistered[msg.sender], "Not registered");
        require(pricePerTask >= MIN_PRICE, "Price too low");

        agents[msg.sender].metadataURI = metadataURI;
        agents[msg.sender].pricePerTask = pricePerTask;

        emit AgentUpdated(msg.sender);
    }

    /**
     * @notice Called by OrchestratorEscrow after job settlement to update stats
     */
    function recordJobCompletion(address agentWallet, uint256 earnedAmount) external {
        // In production: restrict to OrchestratorEscrow contract only
        require(isRegistered[agentWallet], "Agent not registered");

        agents[agentWallet].totalJobsCompleted++;
        agents[agentWallet].totalEarned += earnedAmount;

        emit AgentStatsUpdated(
            agentWallet,
            agents[agentWallet].totalJobsCompleted,
            agents[agentWallet].totalEarned
        );
    }

    /**
     * @notice Find active agents by a single capability
     */
    function getAgentsByCapability(bytes32 capability)
        external view returns (address[] memory)
    {
        address[] storage candidates = capabilityIndex[capability];
        uint256 count = 0;
        for (uint256 i = 0; i < candidates.length; i++) {
            if (agents[candidates[i]].active) count++;
        }

        address[] memory result = new address[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < candidates.length; i++) {
            if (agents[candidates[i]].active) {
                result[idx++] = candidates[i];
            }
        }
        return result;
    }

    /**
     * @notice Get full agent info
     */
    function getAgent(address wallet) external view returns (Agent memory) {
        require(isRegistered[wallet], "Not registered");
        return agents[wallet];
    }

    /**
     * @notice Get all registered agent addresses
     */
    function getAllAgents() external view returns (address[] memory) {
        return allAgents;
    }

    /**
     * @notice Deactivate own agent listing
     */
    function deactivate() external {
        require(isRegistered[msg.sender], "Not registered");
        agents[msg.sender].active = false;
        emit AgentDeactivated(msg.sender);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function hashCapability(string calldata cap) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(cap));
    }
}

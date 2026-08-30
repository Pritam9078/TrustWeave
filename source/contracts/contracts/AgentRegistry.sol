// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControlled} from "./AccessControlled.sol";

/**
 * AI agent registry.
 *
 * Records that an agent exists, who owns it, and whether it is currently permitted to
 * act — plus a commitment to its granted capability set. The capability list itself is
 * NOT stored on-chain: publishing "this agent may create payments" would tell an
 * attacker exactly which credential is worth stealing. The commitment lets an auditor
 * confirm the backend has not quietly widened an agent's powers since registration,
 * without broadcasting what those powers are.
 */
contract AgentRegistry is AccessControlled {
    struct Agent {
        bool exists;
        bool active;
        bool revoked;
        bytes32 ownerCommitment;
        bytes32 capabilityCommitment;
        uint64 registeredAt;
        uint64 updatedAt;
    }

    mapping(bytes32 => Agent) private _agents;
    uint256 public agentCount;

    event AgentRegistered(bytes32 indexed agentCommitment, bytes32 indexed ownerCommitment, bytes32 capabilityCommitment, uint64 at);
    event AgentActiveSet(bytes32 indexed agentCommitment, bool active, uint64 at);
    event AgentRevoked(bytes32 indexed agentCommitment, uint64 at);
    event AgentCapabilitiesChanged(bytes32 indexed agentCommitment, bytes32 previous, bytes32 current, uint64 at);

    error AlreadyRegistered();
    error UnknownAgent();
    error AgentIsRevoked();
    error InvalidCommitment();

    constructor(address initialAdmin) AccessControlled(initialAdmin) {}

    function registerAgent(bytes32 agentCommitment, bytes32 ownerCommitment, bytes32 capabilityCommitment) external onlyWriter {
        if (agentCommitment == bytes32(0)) revert InvalidCommitment();
        if (_agents[agentCommitment].exists) revert AlreadyRegistered();

        _agents[agentCommitment] = Agent({
            exists: true, active: true, revoked: false,
            ownerCommitment: ownerCommitment,
            capabilityCommitment: capabilityCommitment,
            registeredAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp)
        });
        unchecked { agentCount++; }
        emit AgentRegistered(agentCommitment, ownerCommitment, capabilityCommitment, uint64(block.timestamp));
    }

    /** The on-chain half of pause/resume. Reversible by design — unlike revocation. */
    function setActive(bytes32 agentCommitment, bool active) external onlyWriter {
        Agent storage agent = _live(agentCommitment);
        agent.active = active;
        agent.updatedAt = uint64(block.timestamp);
        emit AgentActiveSet(agentCommitment, active, uint64(block.timestamp));
    }

    function revokeAgent(bytes32 agentCommitment) external onlyWriter {
        Agent storage agent = _live(agentCommitment);
        agent.revoked = true;
        agent.active = false;
        agent.updatedAt = uint64(block.timestamp);
        emit AgentRevoked(agentCommitment, uint64(block.timestamp));
    }

    /**
     * Every capability change is an event. An auditor can replay the log and see exactly
     * when an agent's powers changed and to what commitment — a silent widening of an
     * agent's authority is the single most dangerous change in this system, so it is
     * made the most visible.
     */
    function setCapabilityCommitment(bytes32 agentCommitment, bytes32 capabilityCommitment) external onlyWriter {
        Agent storage agent = _live(agentCommitment);
        bytes32 previous = agent.capabilityCommitment;
        agent.capabilityCommitment = capabilityCommitment;
        agent.updatedAt = uint64(block.timestamp);
        emit AgentCapabilitiesChanged(agentCommitment, previous, capabilityCommitment, uint64(block.timestamp));
    }

    function getAgent(bytes32 agentCommitment)
        external view
        returns (bool exists, bool active, bool revoked, bytes32 ownerCommitment, bytes32 capabilityCommitment, uint64 registeredAt, uint64 updatedAt)
    {
        Agent memory agent = _agents[agentCommitment];
        return (agent.exists, agent.active, agent.revoked, agent.ownerCommitment, agent.capabilityCommitment, agent.registeredAt, agent.updatedAt);
    }

    function isActive(bytes32 agentCommitment) external view returns (bool) {
        Agent memory agent = _agents[agentCommitment];
        return agent.exists && agent.active && !agent.revoked;
    }

    function _live(bytes32 agentCommitment) private view returns (Agent storage agent) {
        agent = _agents[agentCommitment];
        if (!agent.exists) revert UnknownAgent();
        if (agent.revoked) revert AgentIsRevoked();
    }
}

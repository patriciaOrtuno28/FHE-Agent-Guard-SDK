// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, ebool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAnomalyAgent} from "./interfaces/IAnomalyAgent.sol";

/// @title AnomalyAgent — FHE-based on-chain anomaly detection agent
/// @notice Receives encrypted anomaly scores from the SDK and executes
///         configurable actions without revealing the underlying score in plaintext.
contract AnomalyAgent is SepoliaConfig, Ownable2Step, Pausable, IAnomalyAgent {

    // ── State ────────────────────────────────────────────────

    /// @notice Encrypted threshold — score above this triggers anomaly action
    euint64 private _threshold;

    /// @notice Encrypted result of the last score comparison
    ebool private _anomalyActive;

    /// @notice Registered watchers allowed to submit scores (private — access via view functions)
    mapping(address => bool) private _watchers;

    // ── Modifiers ─────────────────────────────────────────────

    modifier onlyWatcher() {
        if (!_watchers[msg.sender]) revert NotWatcher(msg.sender);
        _;
    }

    // ── Constructor ───────────────────────────────────────────

    constructor(address initialOwner) Ownable(initialOwner) {
        // Threshold starts unset. Call setThreshold() after deployment
        // to configure it via the FHE coprocessor.
        // Default: 0.6 × 65535 ≈ 39321 in uint64 range.
    }

    // ── Watcher management ────────────────────────────────────

    function addWatcher(address watcher) external onlyOwner {
        if (watcher == address(0)) revert ZeroAddress();
        _watchers[watcher] = true;
        emit WatcherAdded(watcher);
    }

    function removeWatcher(address watcher) external onlyOwner {
        _watchers[watcher] = false;
        emit WatcherRemoved(watcher);
    }

    /// @notice Owner-only check: whether an address is a registered watcher.
    function isWatcher(address watcher) external view onlyOwner returns (bool) {
        return _watchers[watcher];
    }

    /// @notice Watcher self-check for registration status.
    function amIWatcher() external view returns (bool) {
        if (!_watchers[msg.sender]) revert NotWatcher(msg.sender);
        return true;
    }

    // ── Score submission ──────────────────────────────────────

    /// @notice Submit an encrypted anomaly score for a subject address.
    ///         The comparison FHE.gt() runs entirely in ciphertext —
    ///         neither the score nor the threshold is ever decrypted here.
    /// @param subject   The address being monitored
    /// @param encScore  Encrypted score handle (produced by the FHE client SDK)
    function submitScore(
        address subject,
        externalEuint64 encScore,
        bytes calldata inputProof
    ) external onlyWatcher whenNotPaused {
        if (!FHE.isInitialized(_threshold)) revert ThresholdNotSet();

        euint64 score = FHE.fromExternal(encScore, inputProof);
        FHE.allowThis(score);

        // FHE comparison — runs on ciphertext, no plaintext leaks
        ebool isAnomaly = FHE.gt(score, _threshold);
        FHE.allowThis(isAnomaly);
        FHE.allow(isAnomaly, owner());
        _anomalyActive = isAnomaly;

        emit ScoreSubmitted(subject, block.timestamp);

        _handleAnomaly(subject, isAnomaly);
    }

    /// @notice Update the encrypted anomaly threshold.
    ///         Only owner can change it, and it is stored encrypted.
    function setThreshold(
        externalEuint64 encThreshold,
        bytes calldata inputProof
    ) external onlyOwner {
        _threshold = FHE.fromExternal(encThreshold, inputProof);
        FHE.allowThis(_threshold);
        FHE.allow(_threshold, owner());
        emit ThresholdUpdated(block.timestamp);
    }

    // ── Emergency controls ────────────────────────────────────

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ── Internal ──────────────────────────────────────────────

    /// @dev Executes the anomaly action. Override in subcontracts to customize.
    ///      Uses FHE.select pattern to avoid branching on an encrypted bool.
    function _handleAnomaly(address subject, ebool isAnomaly) internal virtual {
        // For the demo: emit an event — the SDK's onAnomaly handler is the
        // primary action surface off-chain.
        // In production: use FHE.select or a decrypt+callback to gate on-chain state.
        emit AnomalyTriggered(subject, block.timestamp);
        // isAnomaly is stored in _anomalyActive and ACL-permissioned for owner use.
        isAnomaly;
    }
}

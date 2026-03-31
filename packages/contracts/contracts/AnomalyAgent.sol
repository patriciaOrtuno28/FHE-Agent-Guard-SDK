// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, ebool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAnomalyAgent} from "./interfaces/IAnomalyAgent.sol";

/// @title AnomalyAgent — FHE-based on-chain anomaly detection agent
/// @notice Receives encrypted anomaly scores from the SDK and executes
///         configurable actions without revealing the underlying score in plaintext.
contract AnomalyAgent is ZamaEthereumConfig, Ownable2Step, Pausable, IAnomalyAgent {

    // ── State ────────────────────────────────────────────────

    /// @notice Encrypted threshold — score above this triggers anomaly action
    euint64 private _threshold;

    /// @notice Encrypted result of the last score comparison
    ebool private _thresholdMet;

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
        /// @notice Encrypted threshold in the same 0..10 scale as the trust score.
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
    ///         Only registered watchers (trusted SDK backends) may call this.
    /// @param subject   The address being monitored
    /// @param encScore  Encrypted score handle (produced by the FHE client SDK)
    function submitScore(
        address subject,
        externalEuint64 encScore,
        bytes calldata inputProof
    ) external onlyWatcher whenNotPaused {
        _processScore(subject, encScore, inputProof);
    }

    /// @notice Self-service variant: any address may submit an encrypted score
    ///         for themselves (requires threshold to be set for the comparison).
    function submitMyScore(
        externalEuint64 encScore,
        bytes calldata inputProof
    ) external whenNotPaused {
        _processScore(msg.sender, encScore, inputProof);
    }

    /// @notice Register an encrypted score for yourself — only grants ACL
    ///         permissions so the subject can decrypt their own score via the
    ///         Zama KMS. Does not require the threshold to be set.
    ///         Use this when you want to prove you encrypted a value without
    ///         triggering the anomaly comparison.
    function registerMyScore(
        externalEuint64 encScore,
        bytes calldata inputProof
    ) external whenNotPaused {
        euint64 score = FHE.fromExternal(encScore, inputProof);
        FHE.allowThis(score);
        FHE.allow(score, msg.sender);
        emit ScoreSubmitted(msg.sender, block.timestamp);
    }

    /// @dev Shared logic for score submission.
    function _processScore(
        address subject,
        externalEuint64 encScore,
        bytes calldata inputProof
    ) internal {
        if (!FHE.isInitialized(_threshold)) revert ThresholdNotSet();

        euint64 score = FHE.fromExternal(encScore, inputProof);
        FHE.allowThis(score);
        FHE.allow(score, subject); // subject can decrypt their raw score via Zama KMS

        // FHE comparison — runs on ciphertext, no plaintext leaks
        ebool meetsThreshold = FHE.ge(score, _threshold);
        FHE.allowThis(meetsThreshold);
        FHE.allow(meetsThreshold, owner());
        FHE.allow(meetsThreshold, subject);
        _thresholdMet = meetsThreshold;

        emit ScoreSubmitted(subject, block.timestamp);

        _handleScoreEvaluation(subject, meetsThreshold);
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
    function _handleScoreEvaluation(address subject, ebool meetsThreshold) internal virtual {
        emit ScoreEvaluated(subject, block.timestamp);
        meetsThreshold;
    }
}

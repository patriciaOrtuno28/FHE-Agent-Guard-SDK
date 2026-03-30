// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {externalEuint64} from "@fhevm/solidity/lib/FHE.sol";

interface IAnomalyAgent {
    // ── Events ────────────────────────────────────────────────
    event WatcherAdded(address indexed watcher);
    event WatcherRemoved(address indexed watcher);
    event ScoreSubmitted(address indexed subject, uint256 timestamp);
    event AnomalyTriggered(address indexed subject, uint256 timestamp);
    event ThresholdUpdated(uint256 timestamp);

    // ── Errors ────────────────────────────────────────────────
    error NotWatcher(address caller);
    error ZeroAddress();
    error ThresholdNotSet();

    // ── Watcher management ────────────────────────────────────
    function addWatcher(address watcher) external;
    function removeWatcher(address watcher) external;
    function isWatcher(address watcher) external view returns (bool);
    function amIWatcher() external view returns (bool);

    // ── Score submission ──────────────────────────────────────
    function submitScore(address subject, externalEuint64 encScore, bytes calldata inputProof) external;
    function submitMyScore(externalEuint64 encScore, bytes calldata inputProof) external;
    function registerMyScore(externalEuint64 encScore, bytes calldata inputProof) external;

    // ── Threshold ─────────────────────────────────────────────
    function setThreshold(externalEuint64 encThreshold, bytes calldata inputProof) external;

    // ── Emergency controls ────────────────────────────────────
    function pause() external;
    function unpause() external;
}

// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {SetConfigParam} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import {UlnConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/UlnBase.sol";

interface IConfigApp {
    function owner() external view returns (address);
    function setDelegate(address delegate) external;
}
interface IDelegateLookup {
    function delegates(address app) external view returns (address);
    function receiveLibraryTimeout(address app, uint32 eid) external view returns (address, uint256);
}

/// @notice NEW LOCAL PROTOTYPE, NOT an audited or production Luvion integration.
/// One receive-ULN configuration / one OApp / one remote EID / one library.
/// The immutable scope intentionally has NO arbitrary-call, owner recovery,
/// key rotation or delegate replacement. This is a serious availability and
/// migration limitation, NOT a proposed production governance model.
/// EVM verifies two business signatures plus a LOCAL attester. It does NOT
/// verify FROST or independently establish the attester checked a certificate.
contract LuvionConfigGate {
    using ECDSA for bytes32;

    struct Change {
        bytes32 beforeHash;
        bytes32 configHash;
        uint256 nonce;
        uint64 validAfter;
        uint64 validUntil;
    }
    struct Schedule {
        uint64 readyAt;
        uint64 validUntil;
        bool cancelled;
        bool executed;
        bytes32 certificateDigest;
    }
    bytes32 private constant CHANGE_TYPE = keccak256(
        "LuvionLocalUlnChange(uint256 chainId,address gate,bytes32 policyHash,address endpoint,address app,address lib,uint32 eid,bytes32 beforeHash,bytes32 configHash,uint256 nonce,uint64 validAfter,uint64 validUntil)"
    );
    bytes32 private constant ATTEST_TYPE = keccak256(
        "LuvionLocalFrostAttestation(bytes32 operationDigest,bytes32 certificateDigest)"
    );
    ILayerZeroEndpointV2 public immutable endpoint;
    address public immutable app;
    address public immutable receiveLib;
    uint32 public immutable remoteEid;
    address public immutable issuer;
    address public immutable operator;
    address public immutable localAttester;
    bytes32 public immutable policyHash;
    uint64 public constant DELAY = 60; // demo seconds, not a production recommendation
    bool public active;
    mapping(bytes32 => Schedule) public schedules;
    mapping(uint256 => bool) public consumedNonces;
    mapping(bytes32 => bool) public consumedCertificates;

    error BadConfiguration();
    error NotReady();
    error BadAuthority();
    error WrongApproval();
    error WrongAttestation();
    error StaleState();
    error InvalidTime();
    error UsedNonce();
    error UsedCertificate();
    error NotExecutable();
    error WrongPayload();
    error NotParty();
    event Activated(address indexed app);
    event Scheduled(bytes32 indexed operationDigest, bytes32 indexed certificateDigest, uint64 readyAt);
    event Executed(bytes32 indexed operationDigest, bytes32 indexed certificateDigest, bytes32 effectiveConfigHash);
    event Cancelled(bytes32 indexed operationDigest, address indexed party);

    constructor(address ep, address a, address lib, uint32 eid, address i, address o, address attester) {
        if (ep.code.length == 0 || a.code.length == 0 || lib.code.length == 0 ||
            eid == 0 || i == address(0) || o == address(0) || attester == address(0) ||
            i == o || i == attester || o == attester) revert BadConfiguration();
        endpoint = ILayerZeroEndpointV2(ep);
        app = a; receiveLib = lib; remoteEid = eid;
        issuer = i; operator = o; localAttester = attester;
        policyHash = keccak256(abi.encode(
            "LUVION/LOCAL-ULN-POLICY/V1", i, o, attester, uint256(2), uint256(DELAY),
            uint256(16), uint256(256), uint256(2), lib, eid
        ));
    }

    /// @dev Ownership transfer alone is insufficient: the old Endpoint delegate
    /// still has power until this transaction replaces it. Local onboarding
    /// tests deliberately demonstrate that gap. Never use this migration on
    /// live funds without an atomic, reviewed transition plan.
    function activate() external {
        if (active || IConfigApp(app).owner() != address(this)) revert BadAuthority();
        IConfigApp(app).setDelegate(address(this));
        active = true;
        _assertAuthority();
        emit Activated(app);
    }

    function _assertAuthority() internal view {
        if (!active) revert NotReady();
        if (IConfigApp(app).owner() != address(this) ||
            IDelegateLookup(address(endpoint)).delegates(app) != address(this)) revert BadAuthority();
        (address lib, bool isDefault) = endpoint.getReceiveLibrary(app, remoteEid);
        (, uint256 graceExpiry) = IDelegateLookup(address(endpoint)).receiveLibraryTimeout(app, remoteEid);
        if (lib != receiveLib || isDefault || graceExpiry != 0) revert BadAuthority();
    }

    function currentConfigHash() public view returns (bytes32) {
        return keccak256(endpoint.getConfig(app, receiveLib, remoteEid, 2));
    }
    function hashChange(Change calldata c) public view returns (bytes32) {
        return keccak256(abi.encode(
            CHANGE_TYPE, block.chainid, address(this), policyHash,
            address(endpoint), app, receiveLib, remoteEid,
            c.beforeHash, c.configHash, c.nonce, c.validAfter, c.validUntil
        ));
    }
    function attestationDigest(bytes32 op, bytes32 cert) public pure returns (bytes32) {
        return keccak256(abi.encode(ATTEST_TYPE, op, cert));
    }
    function _validateConfig(bytes calldata config) internal pure {
        UlnConfig memory u = abi.decode(config, (UlnConfig));
        // Explicit values: do not silently inherit mutable library defaults.
        if (keccak256(config) != keccak256(abi.encode(u)) ||
            u.confirmations < 16 || u.confirmations > 256 ||
            u.requiredDVNCount != 2 || u.requiredDVNs.length != 2 ||
            u.requiredDVNs[0] == address(0) || u.requiredDVNs[0] >= u.requiredDVNs[1] ||
            u.optionalDVNCount != type(uint8).max || u.optionalDVNThreshold != 0 ||
            u.optionalDVNs.length != 0) revert BadConfiguration();
        // Two distinct addresses do NOT prove two independent operators.
    }
    function schedule(
        Change calldata c, bytes calldata config, bytes32 cert,
        bytes calldata issuerSignature, bytes calldata operatorSignature, bytes calldata attestation
    ) external {
        _assertAuthority();
        if (c.validAfter > block.timestamp || c.validUntil <= block.timestamp + DELAY ||
            c.validUntil > block.timestamp + 1 days) revert InvalidTime();
        if (consumedNonces[c.nonce]) revert UsedNonce();
        if (cert == bytes32(0) || consumedCertificates[cert]) revert UsedCertificate();
        if (currentConfigHash() != c.beforeHash) revert StaleState();
        if (keccak256(config) != c.configHash) revert WrongPayload();
        _validateConfig(config);
        bytes32 op = hashChange(c);
        if (op.toEthSignedMessageHash().recover(issuerSignature) != issuer ||
            op.toEthSignedMessageHash().recover(operatorSignature) != operator) revert WrongApproval();
        if (attestationDigest(op, cert).toEthSignedMessageHash().recover(attestation) != localAttester)
            revert WrongAttestation();
        consumedNonces[c.nonce] = true;
        consumedCertificates[cert] = true;
        uint64 readyAt = uint64(block.timestamp) + DELAY;
        schedules[op] = Schedule(readyAt, c.validUntil, false, false, cert);
        emit Scheduled(op, cert, readyAt);
    }
    function execute(Change calldata c, bytes calldata config) external {
        _assertAuthority();
        bytes32 op = hashChange(c);
        Schedule storage s = schedules[op];
        if (s.readyAt == 0 || s.cancelled || s.executed ||
            block.timestamp < s.readyAt || block.timestamp >= s.validUntil) revert NotExecutable();
        if (keccak256(config) != c.configHash) revert WrongPayload();
        if (currentConfigHash() != c.beforeHash) revert StaleState();
        _validateConfig(config);
        s.executed = true;
        SetConfigParam[] memory params = new SetConfigParam[](1);
        params[0] = SetConfigParam(remoteEid, 2, config);
        endpoint.setConfig(app, receiveLib, params);
        emit Executed(op, s.certificateDigest, currentConfigHash());
    }
    function cancel(bytes32 op) external {
        if (msg.sender != issuer && msg.sender != operator) revert NotParty();
        Schedule storage s = schedules[op];
        if (s.readyAt == 0 || s.executed || s.cancelled) revert NotExecutable();
        s.cancelled = true;
        emit Cancelled(op, msg.sender);
    }
}

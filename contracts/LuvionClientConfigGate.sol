// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;
import {LuvionConfigGate} from "./LuvionConfigGate.sol";

/// @notice LOCAL-ONLY client fixture, not an audited production contract.
/// Adds pre-schedule revocation: UI cancellation must invalidate already-exported
/// approvals/attestations even when no schedule has been submitted yet.
contract LuvionClientConfigGate is LuvionConfigGate {
    constructor(address ep,address a,address lib,uint32 eid,address i,address o,address attester)
        LuvionConfigGate(ep,a,lib,eid,i,o,attester) {}

    function revoke(Change calldata c) external {
        if (msg.sender != issuer && msg.sender != operator) revert NotParty();
        bytes32 op = hashChange(c);
        Schedule storage s = schedules[op];
        if (s.executed || s.cancelled) revert NotExecutable();
        consumedNonces[c.nonce] = true;
        s.cancelled = true;
        emit Cancelled(op,msg.sender);
    }
}

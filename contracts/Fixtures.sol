// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

// Compiles actual upstream contracts unchanged. This minimal OApp has no
// token, transfer, receiver or upgrade logic. It is ONLY a configuration fixture.
import {OAppCore} from "@layerzerolabs/oapp-evm/contracts/oapp/OAppCore.sol";
import {EndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/EndpointV2.sol";
import {ReceiveUln302} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/uln302/ReceiveUln302.sol";
import {Safe} from "@safe-global/safe-smart-account/contracts/Safe.sol";
import {SafeProxy} from "@safe-global/safe-smart-account/contracts/proxies/SafeProxy.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

// Generic administration fixture, NOT a bridge or a production adapter.
// Used only for the product's existing read-only pre-sign/handoff workflow.
contract BridgeAdminFixture is AccessControl {
    uint256 public transferLimit = 100;
    constructor() { _grantRole(DEFAULT_ADMIN_ROLE, msg.sender); }
    function setTransferLimit(uint256 limit) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(limit > 0 && limit <= 1000, "fixture limit");
        transferLimit = limit;
    }
}

contract ConfigOnlyOApp is OAppCore {
    constructor(address endpoint, address delegate) OAppCore(endpoint, delegate) {}
    function oAppVersion() public pure override returns (uint64 senderVersion, uint64 receiverVersion) {
        return (0, 0); // not a sending / receiving application
    }
}

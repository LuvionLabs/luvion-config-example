import path from 'node:path';
const runtime = process.env.LUVION_BRIDGE_RUNTIME_DIR;
if (!runtime) throw new Error('An isolated bridge runtime directory is required.');
export default {
  paths: { artifacts: path.join(runtime, 'hardhat-artifacts'), cache: path.join(runtime, 'hardhat-cache') },
  networks: { hardhatMainnet: { type: "edr-simulated", chainType: "l1", chainId: 31337 } }
};

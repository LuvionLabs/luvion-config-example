import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import solc from 'solc';
export const root = path.resolve(import.meta.dirname, '..');
export function compile() {
  const sources = ['contracts/Fixtures.sol', 'contracts/LuvionConfigGate.sol', 'contracts/LuvionClientConfigGate.sol'];
  const input = {
    language:'Solidity',
    sources:Object.fromEntries(sources.map(n=>[n,{content:readFileSync(path.join(root,n),'utf8')}])),
    settings:{optimizer:{enabled:true,runs:200}, viaIR:true, evmVersion:'cancun',
      outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}
  };
  const result=JSON.parse(solc.compile(JSON.stringify(input),{import:n=>{
    try{return {contents:readFileSync(path.join(root,'node_modules',n),'utf8')}}
    catch{return {error:`Missing dependency: ${n}`}}
  }}));
  for(const e of result.errors??[]) if(e.severity==='error') throw Error(e.formattedMessage);
  const selected=['EndpointV2','ReceiveUln302','ConfigOnlyOApp','LuvionConfigGate','LuvionClientConfigGate','Safe','SafeProxy','BridgeAdminFixture'];
  mkdirSync(path.join(root,'artifacts'),{recursive:true});
  for(const [source,contracts] of Object.entries(result.contracts)) for(const [name,c] of Object.entries(contracts)) {
    if (!selected.includes(name)) continue;
    writeFileSync(path.join(root,'artifacts',name+'.json'),JSON.stringify({
      source, name, compiler:solc.version(), abi:c.abi, bytecode:'0x'+c.evm.bytecode.object,
      deployedBytecode:'0x'+c.evm.deployedBytecode.object
    },null,2));
  }
  return {compiler:solc.version(),viaIR:true,optimizerRuns:200,evmVersion:'cancun',contracts:selected};
}
if(process.argv[1]===new URL(import.meta.url).pathname) console.log(compile());

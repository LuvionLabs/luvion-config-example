// Runs only a new loopback Hardhat chain. No external RPC or wallet input.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AbiCoder, Contract, ContractFactory, JsonRpcProvider, FetchRequest, HDNodeWallet, keccak256, getBytes, concat, toBeHex, ZeroAddress} from 'ethers';
import {compile, root} from '../scripts/compile.mjs';

const compilation=compile();
const output=await mkdtemp(path.join(tmpdir(),'luvion-contract-review-'));
const listener=createServer();
await new Promise(r=>listener.listen(0,'127.0.0.1',r));
const port=listener.address().port;await new Promise(r=>listener.close(r));
const chain=spawn(process.execPath,['node_modules/hardhat/dist/src/cli.js','node','--hostname','127.0.0.1','--port',String(port)],{
  cwd:root,stdio:['ignore','ignore','pipe'],env:{...process.env,LUVION_BRIDGE_RUNTIME_DIR:output,HARDHAT_DISABLE_TELEMETRY:'true'}});
let chainError='';chain.stderr.on('data',b=>chainError=(chainError+b).slice(-2000));
chain.on('error',e=>{chainError=e.message;});
const request=new FetchRequest(`http://127.0.0.1:${port}`);request.timeout=3000;
const provider=new JsonRpcProvider(request,undefined,{cacheTimeout:-1});provider.pollingInterval=50;
const results=[];
const check=async(id,fn)=>{await fn();results.push({id,result:'passed'});console.log('PASS',id);};
const rejected=async(contract,fn,expected)=>{
  try{await fn();}catch(e){
    assert.equal(e.code,'CALL_EXCEPTION','Transport errors are not a successful rejection');
    const parsed=contract.interface.parseError(e.data);
    const actual=parsed?.name==='Error'?String(parsed.args[0]):parsed?.name;
    assert.equal(actual,expected);return;
  }
  assert.fail(`Expected contract rejection: ${expected}`);
};
const sourceFiles=['contracts/Fixtures.sol','contracts/LuvionConfigGate.sol','contracts/LuvionClientConfigGate.sol',
  'scripts/compile.mjs','hardhat.config.js','package.json','package-lock.json','review/check.mjs'];
try{
  let ready=false;
  for(let i=0;i<100;i++){
    if(chain.exitCode!==null)throw Error(`Local chain exited: ${chainError}`);
    try{
      const response=await fetch(request.url,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}),signal:AbortSignal.timeout(1000)});
      if((await response.json()).result==='0x7a69'){ready=true;break;}
    }catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(ready,'Local chain startup timed out');
  const admin=await provider.getSigner(0);
  const accounts=[1,2,4].map(i=>HDNodeWallet.fromPhrase('test test test test test test test test test test test junk','',`m/44\'/60\'/0\'/0/${i}`));
  const [issuer,operator,attester]=accounts;
  const deploy=async(name,args=[])=>{
    const a=JSON.parse(await readFile(path.join(root,'artifacts',name+'.json')));
    const c=await new ContractFactory(a.abi,a.bytecode,admin).deploy(...args);
    await c.waitForDeployment();return c;
  };
  const coder=AbiCoder.defaultAbiCoder(),eid=30101;
  const uln=n=>({confirmations:n,requiredDVNCount:2,optionalDVNCount:255,optionalDVNThreshold:0,
    requiredDVNs:['0x0000000000000000000000000000000000001001','0x0000000000000000000000000000000000001002'],optionalDVNs:[]});
  const ulnType='tuple(uint64 confirmations,uint8 requiredDVNCount,uint8 optionalDVNCount,uint8 optionalDVNThreshold,address[] requiredDVNs,address[] optionalDVNs)';
  const encode=n=>coder.encode([ulnType],[uln(n)]);
  const confirmations=async address=>Number(coder.decode([ulnType],await ep.getConfig(address,libAddress,eid,2))[0].confirmations);
  const ep=await deploy('EndpointV2',[30102,await admin.getAddress()]);
  const lib=await deploy('ReceiveUln302',[await ep.getAddress()]);
  const libAddress=await lib.getAddress();
  await(await lib.setDefaultUlnConfigs([{eid,config:{...uln(20),optionalDVNCount:0}}])).wait();
  await(await ep.registerLibrary(libAddress)).wait();
  await(await ep.setDefaultReceiveLibrary(eid,libAddress,0)).wait();
  const app=await deploy('ConfigOnlyOApp',[await ep.getAddress(),await admin.getAddress()]);
  const appAddress=await app.getAddress();
  const params=n=>[{eid,configType:2,config:encode(n)}];
  await(await ep.setReceiveLibrary(appAddress,eid,libAddress,0)).wait();
  await(await ep.setConfig(appAddress,libAddress,params(20))).wait();
  const gate=await deploy('LuvionClientConfigGate',[await ep.getAddress(),appAddress,libAddress,eid,...accounts.map(w=>w.address)]);
  await(await app.transferOwnership(await gate.getAddress())).wait();
  await check('migration-old-delegate-still-has-access-before-activation',async()=>{
    await(await ep.setConfig(appAddress,libAddress,params(24))).wait();
    assert.equal(await confirmations(appAddress),24);
    await(await ep.setConfig(appAddress,libAddress,params(20))).wait();
  });
  await(await gate.activate()).wait();
  await check('old-delegate-rejected-after-activation',()=>rejected(ep,()=>ep.setConfig.staticCall(appAddress,libAddress,params(24)),'LZ_Unauthorized'));
  await check('old-owner-cannot-replace-delegate',()=>rejected(app,()=>app.setDelegate.staticCall(admin.address),'Ownable: caller is not the owner'));
  const config=encode(32),now=Number((await provider.getBlock('latest')).timestamp);
  const change={beforeHash:await gate.currentConfigHash(),configHash:keccak256(config),nonce:1,validAfter:now-1,validUntil:now+3600};
  const digest=await gate.hashChange(change),cert=keccak256(Buffer.from('LOCAL SYNTHETIC ATTESTATION; NOT FROST'));
  const sigI=await issuer.signMessage(getBytes(digest)),sigO=await operator.signMessage(getBytes(digest));
  const sigA=await attester.signMessage(getBytes(await gate.attestationDigest(digest,cert)));
  await check('wrong-local-attestation-rejected',()=>rejected(gate,()=>gate.schedule.staticCall(change,config,cert,sigI,sigO,sigI),'WrongAttestation'));
  await check('missing-issuer-approval-rejected',()=>rejected(gate,()=>gate.schedule.staticCall(change,config,cert,sigO,sigO,sigA),'WrongApproval'));
  await check('missing-operator-approval-rejected',()=>rejected(gate,()=>gate.schedule.staticCall(change,config,cert,sigI,sigI,sigA),'WrongApproval'));
  await check('changed-payload-rejected',()=>rejected(gate,()=>gate.schedule.staticCall(change,encode(48),cert,sigI,sigO,sigA),'WrongPayload'));
  await check('resigned-payload-required',()=>rejected(gate,()=>gate.schedule.staticCall({...change,configHash:keccak256(encode(48))},encode(48),cert,sigI,sigO,sigA),'WrongApproval'));
  await check('no-schedule-no-execution',()=>rejected(gate,()=>gate.execute.staticCall(change,config),'NotExecutable'));
  await(await gate.schedule(change,config,cert,sigI,sigO,sigA)).wait();
  await check('waiting-period-enforced',()=>rejected(gate,()=>gate.execute.staticCall(change,config),'NotExecutable'));
  // Test-only time travel; the hosted customer flow waits in real time.
  await provider.send('evm_increaseTime',[61]);await provider.send('evm_mine',[]);
  await check('changed-execution-payload-rejected',()=>rejected(gate,()=>gate.execute.staticCall(change,encode(48)),'WrongPayload'));
  let receipt;
  await check('approved-change-executes-and-effective-config-matches',async()=>{
    receipt=await(await gate.execute(change,config)).wait();assert.equal(receipt.status,1);
    assert.equal(await confirmations(appAddress),32);
  });
  await check('execution-replay-rejected',()=>rejected(gate,()=>gate.execute.staticCall(change,config),'NotExecutable'));
  const revoked={...change,beforeHash:await gate.currentConfigHash(),nonce:2};
  const revokedDigest=await gate.hashChange(revoked),revokedCert=keccak256(Buffer.from('SECOND SYNTHETIC ATTESTATION'));
  const revokedI=await issuer.signMessage(getBytes(revokedDigest)),revokedO=await operator.signMessage(getBytes(revokedDigest));
  const revokedA=await attester.signMessage(getBytes(await gate.attestationDigest(revokedDigest,revokedCert)));
  await(await gate.connect(await provider.getSigner(1)).revoke(revoked)).wait();
  await check('revoked-request-cannot-be-scheduled',()=>rejected(gate,()=>gate.schedule.staticCall(revoked,config,revokedCert,revokedI,revokedO,revokedA),'UsedNonce'));

  // Real Safe 1.5.0: 2-of-2 correctly represents these two parties too.
  const singleton=await deploy('Safe'),proxy=await deploy('SafeProxy',[await singleton.getAddress()]);
  const safe=new Contract(await proxy.getAddress(),singleton.interface,admin);
  await(await safe.setup([issuer.address,operator.address],2,ZeroAddress,'0x',ZeroAddress,ZeroAddress,0,ZeroAddress)).wait();
  const safeApp=await deploy('ConfigOnlyOApp',[await ep.getAddress(),await admin.getAddress()]);
  const safeAppAddress=await safeApp.getAddress();
  await(await ep.setReceiveLibrary(safeAppAddress,eid,libAddress,0)).wait();
  await(await ep.setConfig(safeAppAddress,libAddress,params(20))).wait();
  await(await safeApp.setDelegate(await safe.getAddress())).wait();
  await(await safeApp.transferOwnership(await safe.getAddress())).wait();
  const data=ep.interface.encodeFunctionData('setConfig',[safeAppAddress,libAddress,params(32)]);
  const args=[await ep.getAddress(),0,data,0,0,0,0,ZeroAddress,ZeroAddress];
  const txHash=await safe.getTransactionHash(...args,await safe.nonce());
  const signatures=await Promise.all([issuer,operator].sort((a,b)=>a.address.toLowerCase().localeCompare(b.address.toLowerCase())).map(async w=>{
    const s=getBytes(await w.signMessage(getBytes(txHash)));return concat([s.slice(0,64),toBeHex(s[64]+4,1)]);
  }));
  await check('safe-2-of-2-missing-party-rejected',()=>rejected(safe,()=>safe.execTransaction.staticCall(...args,signatures[0]),'GS020'));
  await check('safe-also-binds-signatures-to-exact-calldata',()=>rejected(safe,()=>safe.execTransaction.staticCall(...[...args.slice(0,2),ep.interface.encodeFunctionData('setConfig',[safeAppAddress,libAddress,params(48)]),...args.slice(3)],concat(signatures)),'GS026'));
  await check('safe-2-of-2-approved-change-executes',async()=>{
    await(await safe.execTransaction(...args,concat(signatures))).wait();
    assert.equal(await confirmations(safeAppAddress),32);
  });
  const sourceHashes={};
  for(const f of sourceFiles)sourceHashes[f]=createHash('sha256').update(await readFile(path.join(root,f))).digest('hex');
  const report={schema:1,generatedAt:new Date().toISOString(),scope:'Local contract checks, not a full Luvion or hosted-session test',
    compilation,sourceHashes,results,localExecution:{transaction:receipt.hash,block:receipt.blockNumber,chainId:31337},
    limitations:['Synthetic ECDSA attester; no FROST verification in this standalone kit','All test keys controlled by one local process; no independent institutions',
      'No customer contracts, bridge transfers, public-chain transactions, recovery or audit','Safe 2-of-2 satisfies this two-party approval example too; no superiority or integration-cost claim',
      'Activation migration has an old-delegate bypass window; not a production migration plan','These checks do not exhaust all bypasses or upstream protocol risks']};
  await writeFile(path.join(root,'artifacts/review-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(`Completed ${results.length} local contract checks.`);
}finally{
  provider.destroy();
  if(chain.exitCode===null){chain.kill('SIGTERM');await Promise.race([new Promise(r=>chain.once('exit',r)),new Promise(r=>setTimeout(r,2000))]);}
  if(chain.exitCode===null)chain.kill('SIGKILL');
  await rm(output,{recursive:true,force:true});
}

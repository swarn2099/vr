// Run from v1 with: node --import tsx scripts/learn-with-codex.mjs ESTATE_ROOT STATE_DIRECTORY
// Interpretation only: no evaluation tasks, source edits, new source collection or investigation execution.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {rpc} from '../src/client.ts';
import {preparePrompt} from '../src/learning.ts';
import {interpretWithCodex,CODEX_MODEL,CODEX_REASONING} from '../src/codex-provider.ts';
import {acquireServiceLock} from '../src/service-lock.ts';
const root=path.resolve(process.argv[2]??''),state=process.argv[3];
assert.ok(state,'Supply estate root and existing VR state directory');
const estate=JSON.parse(await readFile(path.join(root,'.vr/config.json'),'utf8'));
const base=path.resolve(import.meta.dirname,'../evaluation/results/codex-understanding');
await mkdir(base,{recursive:true});const unlock=await acquireServiceLock(base);
const runId=new Date().toISOString().replace(/[:.]/g,'-'),directory=path.join(base,runId);
await mkdir(directory,{recursive:true});
const stages=['history','github-issues'];
const summary={runId,startedAt:new Date().toISOString(),state:'running',root,productId:estate.productId,model:CODEX_MODEL,reasoning:CODEX_REASONING,cliVersion:execFileSync('codex',['--version'],{encoding:'utf8'}).trim(),stages,attempts:[],comparisonsRun:0};
const save=async()=>{await writeFile(path.join(directory,'summary.json'),JSON.stringify(summary,null,2));await writeFile(path.join(base,'latest.json'),JSON.stringify({directory,...summary},null,2));};
const overview=()=>rpc(state,'overview',{productId:estate.productId});
const initial=await overview(),source=initial.sources.find(s=>s.id===estate.sourceId),checkpoint=source.checkpoint;
const activeJobs=o=>o.jobs.filter(j=>j.snapshot_id===checkpoint&&!j.details?.localOverlay);
summary.before=activeJobs(initial).map(j=>({id:j.id,stage:j.stage,state:j.state,processed:j.processed,total:j.total,calls:j.calls}));
await save();let failures=0;
try {
  assert.equal(source.attributes.pipeline.stages.historicalCode,true);
  assert.equal(source.attributes.pipeline.stages.githubIssues,true);
  for(const stage of ['current','connections'])assert.equal(activeJobs(initial).findLast(j=>j.stage===stage)?.state,'completed',`Complete ${stage} before interpreting history`);
  for(let call=0;call<100;call++) {
    const now=await overview();assert.equal(now.sources.find(s=>s.id===estate.sourceId).checkpoint,checkpoint,'Estate checkpoint changed during the run');
    const batch=await rpc(state,'learn.next',{productId:estate.productId,model:`codex-cli/${CODEX_MODEL}/${CODEX_REASONING}`,charBudget:failures?Math.max(10000,Math.floor(44000/2**failures)):44000,stages},true);
    if(batch.waiting)throw Error(batch.reason);
    if(batch.done)break;
    assert.ok(stages.includes(batch.stage),'Worker received a stage outside the user request');
    const attempt={batchId:batch.batchId,jobId:batch.jobId,stage:batch.stage,evidenceRanges:batch.evidence.length,startedAt:new Date().toISOString(),state:'running'};
    summary.attempts.push(attempt);await save();console.log(JSON.stringify({event:'batch-started',call:call+1,...attempt}));
    try {
      const prepared=preparePrompt(batch);
      await writeFile(path.join(directory,`${batch.batchId}-batch.json`),JSON.stringify(batch,null,2));
      await rpc(state,'learn.request',{batchId:batch.batchId,prompt:prepared.prompt,promptVersion:'vr-understanding-2/codex-cli-1',inputTokens:null},true);
      const generated=await interpretWithCodex({root,directory:path.join(directory,batch.batchId),prompt:prepared.prompt});
      await rpc(state,'learn.response',{batchId:batch.batchId,text:generated.text,inputTokens:generated.usage?.input_tokens??null},true);
      const proposal=prepared.resolve(generated.text);
      const published=await rpc(state,'learn.publish',{batchId:batch.batchId,proposal,inputTokens:generated.usage?.input_tokens,outputChars:generated.text.length},true);
      Object.assign(attempt,{state:'completed',finishedAt:new Date().toISOString(),usage:generated.usage,threadId:generated.threadId,elapsedMs:generated.elapsedMs,published,findings:proposal.findings.length,relationships:proposal.relationships.length,questions:proposal.questions.length});
      failures=0;
    }catch(error) {
      Object.assign(attempt,{state:'failed',finishedAt:new Date().toISOString(),error:String(error)});
      await rpc(state,'learn.fail',{batchId:batch.batchId,error:String(error)},true);failures++;
      if(failures>=3||/quota|usage.limit|credit.limit|authentication|not supported|cancelled/i.test(String(error)))throw error;
    }finally{await save();console.log(JSON.stringify({event:'batch-finished',...attempt}));}
  }
  const final=await overview(),jobs=activeJobs(final);
  for(const stage of stages){const job=jobs.findLast(j=>j.stage===stage);assert.equal(job?.state,'completed',`The ${stage} stage is unfinished`);assert.equal(job.processed,job.total);}
  for(const stage of ['current','connections','investigation']){
    const before=summary.before.filter(j=>j.stage===stage).reduce((n,j)=>n+j.calls,0);
    assert.equal(jobs.filter(j=>j.stage===stage).reduce((n,j)=>n+j.calls,0),before,`Unexpected ${stage} model calls`);
  }
  for(let i=0;i<100;i++){const indexed=await rpc(state,'index',{productId:estate.productId,limit:100},true);if(!indexed.remaining||!indexed.indexed){summary.index=indexed;break;}}
  summary.after=jobs.map(j=>({id:j.id,stage:j.stage,state:j.state,processed:j.processed,total:j.total,calls:j.calls}));
  summary.openQuestions=final.questions.filter(q=>q.state==='open').length;
  summary.state='completed';summary.finishedAt=new Date().toISOString();
  await save();console.log(JSON.stringify({event:'completed',directory,stages:summary.after.filter(j=>stages.includes(j.stage)),openQuestions:summary.openQuestions}));
}catch(error){summary.state='failed';summary.error=String(error);summary.finishedAt=new Date().toISOString();await save();throw error;}
finally{await unlock();}

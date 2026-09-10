import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {rpc} from '../src/client.ts';
import {preparePrompt} from '../src/learning.ts';
import {inspectCodexEvents} from '../src/codex-provider.ts';
const base=path.resolve(import.meta.dirname,'../evaluation/results/codex-understanding'),state=process.argv[2];
assert.ok(state,'Supply VR state directory');
const run=JSON.parse(await readFile(path.join(base,'latest.json'),'utf8'));
assert.equal(run.state,'completed','Interpretation has not completed');
const overview=await rpc(state,'overview',{productId:run.productId});
const required=['history','github-issues'];
const jobs=required.map(stage=>overview.jobs.findLast(j=>j.stage===stage));
for(const job of jobs){assert.equal(job.state,'completed');assert.equal(job.processed,job.total);}
const counts={history:{batches:0,findings:0,relationships:0,questions:0},'github-issues':{batches:0,findings:0,relationships:0,questions:0}};
const usage={input_tokens:0,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0};
for(const attempt of run.attempts.filter(a=>a.state==='completed')) {
  const folder=path.join(run.directory,attempt.batchId),invocation=JSON.parse(await readFile(path.join(folder,'invocation.json'),'utf8'));
  assert.equal(invocation.model,'gpt-5.6-sol');assert.equal(invocation.reasoning,'medium');
  const events=(await readFile(path.join(folder,'events.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const inspected=inspectCodexEvents(events);assert.equal(inspected.threadId,attempt.threadId);
  for(const field of Object.keys(usage))usage[field]+=inspected.usage?.[field]??0;
  const batch=JSON.parse(await readFile(path.join(run.directory,attempt.batchId+'-batch.json'),'utf8'));
  const proposal=preparePrompt(batch).resolve(await readFile(path.join(folder,'response.json'),'utf8'));
  counts[attempt.stage].batches++;for(const field of ['findings','relationships','questions'])counts[attempt.stage][field]+=proposal[field].length;
}
// Retrieve exact persisted support from one accepted batch per source kind.
for(const stage of required) {
  const attempt=run.attempts.findLast(a=>a.stage===stage&&a.state==='completed');assert.ok(attempt);
  const batch=JSON.parse(await readFile(path.join(run.directory,attempt.batchId+'-batch.json'),'utf8'));
  const samples=batch.evidence.slice(0,3),read=await rpc(state,'vr_evidence',{productId:run.productId,ids:samples.map(e=>e.id),charBudget:100000});
  assert.equal(read.omitted.length,0);
  for(const source of samples){const stored=read.evidence.find(e=>e.id===source.id);assert.equal(stored.body,source.body);assert.equal(stored.revision,source.revision);}
}
const result={verified:true,recordedAt:new Date().toISOString(),runDirectory:run.directory,model:'gpt-5.6-sol',reasoning:'medium',cliVersion:run.cliVersion,completedStages:jobs.map(j=>({stage:j.stage,processed:j.processed,total:j.total,state:j.state})),newPublishedRecords:counts,usage,failedAttempts:run.attempts.filter(a=>a.state==='failed').length,openQuestions:overview.questions.filter(q=>q.state==='open').length,queuedInvestigations:overview.jobs.filter(j=>j.stage==='investigation'&&j.state==='pending').length,comparisonsRun:0,limitations:['Counts describe interpreted configured evidence, not verified runtime behavior.','11 GitHub issues have incomplete comment sets under the source-read budget.','Open questions remain unresolved; investigations were not executed in this run.','Usage includes Codex host instructions and successful interpretation turns; preflight and failed attempt usage are recorded separately.']};
await writeFile(path.join(base,'completion.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

async function availablePort() {
  const server=createServer();
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
  const {port}=server.address();
  await new Promise(resolve=>server.close(resolve));
  return port;
}

test('clarification resolution synchronizes only its task and persists provisional answers', async t => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'meetmind-clarification-'));
  const dbPath=path.join(dir,'test.sqlite');
  const port=await availablePort();
  // Simulate a pre-fix database whose clarifications table has no action_id column.
  const seedDb=new DatabaseSync(dbPath);
  seedDb.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE meetings(id INTEGER PRIMARY KEY,title TEXT NOT NULL,meeting_date TEXT,participants TEXT NOT NULL DEFAULT '[]',category TEXT,transcript TEXT NOT NULL,summary TEXT NOT NULL,key_points TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE decisions(id INTEGER PRIMARY KEY,meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,title TEXT NOT NULL,description TEXT NOT NULL,evidence TEXT,confidence TEXT NOT NULL DEFAULT 'medium',kind TEXT NOT NULL DEFAULT 'confirmed');
    CREATE TABLE actions(id INTEGER PRIMARY KEY,meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,title TEXT NOT NULL,description TEXT NOT NULL,owner TEXT,deadline TEXT,priority TEXT NOT NULL DEFAULT 'medium',status TEXT NOT NULL DEFAULT 'pending',source_excerpt TEXT,confidence TEXT NOT NULL DEFAULT 'medium',needs_clarification INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE followups(id INTEGER PRIMARY KEY,meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,title TEXT NOT NULL,description TEXT NOT NULL,owner TEXT,deadline TEXT);
    CREATE TABLE clarifications(id INTEGER PRIMARY KEY,meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,related_title TEXT,issue TEXT NOT NULL,question TEXT NOT NULL,answer TEXT,resolved INTEGER NOT NULL DEFAULT 0);`);
  seedDb.close();

  const childEnv={...process.env,PORT:String(port),DATABASE_PATH:dbPath,AI_PROVIDER:'groq'};
  delete childEnv.GROQ_API_KEY;
  const child=spawn(process.execPath,['src/server.js'],{cwd:path.resolve('.'),env:childEnv,stdio:['ignore','ignore','pipe']});
  let serverError='';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>{serverError+=chunk;});
  t.after(async()=>{
    if(child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}
    rmSync(dir,{recursive:true,force:true});
  });

  const base=`http://127.0.0.1:${port}/api`;
  let ready=false;
  for(let i=0;i<100;i++){
    if(child.exitCode!==null) break;
    try { const r=await fetch(`${base}/health`); if(r.ok){ready=true;break;} } catch {}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(ready,true,`backend did not start${serverError?`: ${serverError}`:''}`);

  const db=new DatabaseSync(dbPath);
  const meeting=db.prepare("INSERT INTO meetings(title,transcript,summary,key_points) VALUES(?,?,?,?)").run('Synthetic clarification sync test','Synthetic transcript for database behavior tests.','Synthetic summary.','[]');
  const meetingId=Number(meeting.lastInsertRowid);
  const insertAction=db.prepare('INSERT INTO actions(meeting_id,title,description,owner,deadline,priority,status,needs_clarification) VALUES(?,?,?,?,?,?,?,?)');
  const sponsor=Number(insertAction.run(meetingId,'Assign sponsorship owner','Coordinate sponsor outreach.',null,null,'medium','pending',1).lastInsertRowid);
  const review=Number(insertAction.run(meetingId,'Schedule progress review','Schedule a progress review meeting.',null,null,'medium','pending',1).lastInsertRowid);
  const unrelated=Number(insertAction.run(meetingId,'Publish launch checklist','Publish the approved checklist.','Priya','2026-11-03','high','completed',0).lastInsertRowid);
  const legacy=Number(insertAction.run(meetingId,'Confirm launch venue','Confirm venue details.',null,null,'medium','pending',1).lastInsertRowid);
  const insertClarification=db.prepare('INSERT INTO clarifications(meeting_id,related_title,issue,question,answer,resolved) VALUES(?,?,?,?,?,?)');
  const sponsorClarification=Number(insertClarification.run(meetingId,'Assign sponsorship owner','The assignment is provisional.','Who will own sponsor outreach?',null,0).lastInsertRowid);
  const reviewClarification=Number(insertClarification.run(meetingId,'Schedule progress review','The date is proposed only.','When will the review take place?',null,0).lastInsertRowid);
  insertClarification.run(meetingId,'Confirm launch venue','Legacy clarification already answered.','Was the venue confirmed?','Venue confirmation is recorded.',1);
  db.close();

  const sendAnswer=async(id,answer)=>fetch(`${base}/clarifications/${id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({answer,resolved:true})});
  const sponsorAnswer='Ananya will be the sponsorship owner and will coordinate sponsor outreach. The team will confirm the final assignment in the next meeting.';
  const emptyAnswer=await sendAnswer(sponsorClarification,'   ');
  assert.equal(emptyAnswer.status,400,'empty answers must not resolve a clarification');
  const stillOpen=await (await fetch(`${base}/meetings/${meetingId}`)).json();
  assert.equal(stillOpen.meeting.clarifications.find(x=>x.id===sponsorClarification).resolved,false);
  const sponsorResponse=await sendAnswer(sponsorClarification,sponsorAnswer);
  assert.equal(sponsorResponse.status,200);
  const sponsorBody=await sponsorResponse.json();
  assert.equal(sponsorBody.clarification.answer,sponsorAnswer);
  assert.equal(sponsorBody.clarification.resolved,true);
  assert.equal(sponsorBody.actionLinked,true);
  const sponsorTask=sponsorBody.meeting.actionItems.find(x=>x.id===sponsor);
  assert.equal(sponsorTask.needsClarification,false);
  assert.equal(sponsorTask.owner,null,'provisional owner must not become the final task owner');
  assert.equal(sponsorTask.deadline,null);
  assert.equal(sponsorTask.status,'pending');

  const reviewAnswer='November 1 is the proposed date for the progress review meeting, but the team has not confirmed it yet.';
  const reviewResponse=await sendAnswer(reviewClarification,reviewAnswer);
  assert.equal(reviewResponse.status,200);
  const reviewBody=await reviewResponse.json();
  const reviewTask=reviewBody.meeting.actionItems.find(x=>x.id===review);
  assert.equal(reviewBody.clarification.answer,reviewAnswer);
  assert.equal(reviewBody.clarification.resolved,true);
  assert.equal(reviewTask.needsClarification,false);
  assert.equal(reviewTask.deadline,null,'proposed date must not become a confirmed deadline');
  assert.equal(reviewTask.status,'pending');

  const again=await sendAnswer(sponsorClarification,sponsorAnswer);
  assert.equal(again.status,200,'repeated resolution should be idempotent');
  const reopened=await (await fetch(`${base}/meetings/${meetingId}`)).json();
  assert.equal(reopened.meeting.clarifications.find(x=>x.id===sponsorClarification).answer,sponsorAnswer);
  assert.equal(reopened.meeting.clarifications.find(x=>x.id===sponsorClarification).resolved,true);
  assert.equal(reopened.meeting.actionItems.find(x=>x.id===sponsor).needsClarification,false);
  assert.equal(reopened.meeting.actionItems.find(x=>x.id===review).needsClarification,false);
  const other=reopened.meeting.actionItems.find(x=>x.id===unrelated);
  assert.deepEqual({owner:other.owner,deadline:other.deadline,priority:other.priority,status:other.status},{owner:'Priya',deadline:'2026-11-03',priority:'high',status:'completed'});
  assert.equal(reopened.meeting.actionItems.find(x=>x.id===legacy).needsClarification,false,'older saved report with no action_id should load consistently');
  assert.equal(reopened.meeting.clarifications.filter(x=>x.question==='Who will own sponsor outreach?').length,1);
  const invalid=await fetch(`${base}/clarifications/0`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({answer:'invalid',resolved:true})});
  assert.equal(invalid.status,400);
  const missing=await fetch(`${base}/clarifications/999999`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({answer:'not found',resolved:true})});
  assert.equal(missing.status,404);
});

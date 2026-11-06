import express from 'express';
import cors from 'cors';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { analyzeTranscript } from './ai.js';
import { safeErrorDetail, safeValidationIssues } from './diagnostics.js';

const dbPath = config.databasePath;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath); db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE IF NOT EXISTS meetings(id INTEGER PRIMARY KEY, title TEXT NOT NULL, meeting_date TEXT, participants TEXT NOT NULL DEFAULT '[]', category TEXT, transcript TEXT NOT NULL, summary TEXT NOT NULL, key_points TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS decisions(id INTEGER PRIMARY KEY, meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT NOT NULL, evidence TEXT, confidence TEXT NOT NULL DEFAULT 'medium', kind TEXT NOT NULL DEFAULT 'confirmed');
CREATE TABLE IF NOT EXISTS actions(id INTEGER PRIMARY KEY, meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT NOT NULL, owner TEXT, deadline TEXT, priority TEXT NOT NULL DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'pending', source_excerpt TEXT, confidence TEXT NOT NULL DEFAULT 'medium', needs_clarification INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS followups(id INTEGER PRIMARY KEY, meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT NOT NULL, owner TEXT, deadline TEXT);
CREATE TABLE IF NOT EXISTS clarifications(id INTEGER PRIMARY KEY, meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, action_id INTEGER REFERENCES actions(id) ON DELETE SET NULL, related_title TEXT, issue TEXT NOT NULL, question TEXT NOT NULL, answer TEXT, resolved INTEGER NOT NULL DEFAULT 0);`);
// Older databases may predate the optional clarification-to-action link.
if (!db.prepare('PRAGMA table_info(clarifications)').all().some(column => column.name === 'action_id')) {
  db.exec('ALTER TABLE clarifications ADD COLUMN action_id INTEGER REFERENCES actions(id) ON DELETE SET NULL');
}
const app = express(); app.use(cors({ origin: config.clientOrigin })); app.use(express.json({ limit: '1mb' }));
const fail = (status, message) => Object.assign(new Error(message), { status });
const transaction = fn => (...args) => { db.exec('BEGIN'); try { const result=fn(...args); db.exec('COMMIT'); return result; } catch(e) { db.exec('ROLLBACK'); throw e; } };
const parse = x => { try{return JSON.parse(x);}catch{return [];} };
function report(id) {
  const m=db.prepare('SELECT * FROM meetings WHERE id=?').get(id);
  if(!m)return null;
  const clarifications=db.prepare('SELECT * FROM clarifications WHERE meeting_id=?').all(id);
  const actionRows=db.prepare('SELECT * FROM actions WHERE meeting_id=?').all(id);
  const actionTitleCounts=new Map();
  for(const a of actionRows) actionTitleCounts.set(a.title,(actionTitleCounts.get(a.title)||0)+1);
  const linkedClarificationFor=action=>clarifications.filter(c=>c.action_id===action.id||(c.action_id==null&&c.related_title===action.title&&actionTitleCounts.get(action.title)===1));
  return {...m,participants:parse(m.participants),keyPoints:parse(m.key_points),decisions:db.prepare('SELECT * FROM decisions WHERE meeting_id=?').all(id),actionItems:actionRows.map(a=>{const linked=linkedClarificationFor(a);const hasLinked=linked.length>0;const hasOpen=linked.some(c=>!c.resolved);return {...a,needsClarification:hasLinked?hasOpen:!!a.needs_clarification};}),followUps:db.prepare('SELECT * FROM followups WHERE meeting_id=?').all(id),clarifications:clarifications.map(c=>({...c,resolved:!!c.resolved}))};
}
app.get('/api/health',(_q,r)=>r.json({ok:true,provider:config.aiProvider,configured:!!config.groqApiKey&&config.groqApiKey!=='your_groq_api_key_here',model:config.groqModel}));
app.post('/api/meetings',async(req,res,next)=>{try{const b=z.object({title:z.string().trim().min(1).max(200),date:z.string().max(40).optional().nullable(),participants:z.array(z.string().trim().min(1).max(100)).max(100).default([]),category:z.string().max(100).optional().nullable(),transcript:z.string().trim().min(20).max(100000)}).parse(req.body); const a=await analyzeTranscript(b); const save=transaction(()=>{const x=db.prepare('INSERT INTO meetings(title,meeting_date,participants,category,transcript,summary,key_points) VALUES(?,?,?,?,?,?,?)').run(b.title,b.date||null,JSON.stringify(b.participants),b.category||null,b.transcript,a.meetingSummary,JSON.stringify(a.keyPoints)); const id=Number(x.lastInsertRowid); const di=db.prepare('INSERT INTO decisions(meeting_id,title,description,evidence,confidence,kind) VALUES(?,?,?,?,?,?)'); a.decisions.forEach(d=>di.run(id,d.title,d.description,d.evidence||'',d.confidence,d.kind)); const ai=db.prepare('INSERT INTO actions(meeting_id,title,description,owner,deadline,priority,status,source_excerpt,confidence,needs_clarification) VALUES(?,?,?,?,?,?,?,?,?,?)'); a.actionItems.forEach(v=>ai.run(id,v.title,v.description,v.owner||null,v.deadline||null,v.priority,v.status,v.sourceExcerpt||'',v.confidence,v.needsClarification?1:0)); const fu=db.prepare('INSERT INTO followups(meeting_id,title,description,owner,deadline) VALUES(?,?,?,?,?)'); a.followUps.forEach(v=>fu.run(id,v.title,v.description,v.owner||null,v.deadline||null)); const cl=db.prepare('INSERT INTO clarifications(meeting_id,action_id,related_title,issue,question,resolved) VALUES(?,?,?,?,?,?)'); a.clarifications.forEach(v=>{const related=a.actionItems.find(t=>t.title===v.relatedActionTitle)?.title;const actionId=related?db.prepare('SELECT id FROM actions WHERE meeting_id=? AND title=?').get(id,related)?.id:null;cl.run(id,actionId||null,v.relatedActionTitle||null,v.issue,v.question,v.resolved?1:0);}); return id; }); res.status(201).json({meeting:report(save())});}catch(e){next(e);}});
app.get('/api/meetings',(req,res)=>{const q=(req.query.q||'').toString().slice(0,200); const rows=db.prepare(`SELECT m.*, (SELECT count(*) FROM actions a WHERE a.meeting_id=m.id) action_count, (SELECT count(*) FROM decisions d WHERE d.meeting_id=m.id) decision_count FROM meetings m WHERE m.title LIKE ? OR m.transcript LIKE ? ORDER BY m.created_at DESC`).all(`%${q}%`,`%${q}%`);res.json({meetings:rows.map(m=>({...m,participants:parse(m.participants),key_points:undefined}))});});
app.get('/api/meetings/:id',(req,res)=>{const m=report(Number(req.params.id));if(!m)return res.status(404).json({error:'Meeting not found.'});res.json({meeting:m});});
app.patch('/api/meetings/:id', (req,res,next)=>{try{const id=Number(req.params.id), b=z.object({title:z.string().trim().min(1).max(200).optional(),meeting_date:z.string().nullable().optional(),participants:z.array(z.string()).optional(),category:z.string().nullable().optional(),summary:z.string().max(10000).optional(),keyPoints:z.array(z.string()).optional()}).parse(req.body);if(!report(id))throw fail(404,'Meeting not found.'); const fields=[],vals=[];for(const [k,v] of Object.entries(b)){const col=k==='keyPoints'?'key_points':k==='meeting_date'?'meeting_date':k==='participants'?'participants':k;if(!['title','meeting_date','participants','category','summary','key_points'].includes(col))continue;fields.push(`${col}=?`);vals.push(k==='participants'||k==='keyPoints'?JSON.stringify(v):v);}if(fields.length)db.prepare(`UPDATE meetings SET ${fields.join(',')} WHERE id=?`).run(...vals,id);res.json({meeting:report(id)});}catch(e){next(e);}});
app.delete('/api/meetings/:id',(req,res)=>{const x=db.prepare('DELETE FROM meetings WHERE id=?').run(Number(req.params.id));if(!x.changes)return res.status(404).json({error:'Meeting not found.'});res.status(204).end();});
app.get('/api/actions',(req,res)=>{let sql='SELECT a.*,m.title meeting_title,m.meeting_date FROM actions a JOIN meetings m ON m.id=a.meeting_id WHERE 1=1',v=[];if(req.query.status){sql+=' AND a.status=?';v.push(req.query.status);}if(req.query.q){sql+=' AND (a.title LIKE ? OR a.owner LIKE ? OR m.title LIKE ?)';v.push(...Array(3).fill(`%${String(req.query.q).slice(0,100)}%`));}sql+=' ORDER BY CASE WHEN a.deadline IS NULL THEN 1 ELSE 0 END,a.deadline';res.json({actions:db.prepare(sql).all(...v).map(a=>({...a,needsClarification:!!a.needs_clarification}))});});
app.patch('/api/actions/:id',(req,res,next)=>{try{const b=z.object({title:z.string().min(1).max(500).optional(),description:z.string().max(3000).optional(),owner:z.string().max(200).nullable().optional(),deadline:z.string().max(40).nullable().optional(),priority:z.enum(['low','medium','high']).optional(),status:z.enum(['pending','in_progress','completed']).optional()}).parse(req.body);if(!Object.keys(b).length)throw fail(400,'Provide at least one field.');const x=db.prepare(`UPDATE actions SET ${Object.keys(b).map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...Object.values(b),Number(req.params.id));if(!x.changes)throw fail(404,'Action item not found.');res.json({action:db.prepare('SELECT * FROM actions WHERE id=?').get(Number(req.params.id))});}catch(e){next(e);}});
app.get('/api/clarifications',(req,res)=>res.json({clarifications:db.prepare('SELECT c.*,a.title action_title FROM clarifications c LEFT JOIN actions a ON a.id=c.action_id ORDER BY c.resolved,c.id DESC').all().map(c=>({...c,resolved:!!c.resolved}))}));
app.patch('/api/clarifications/:id',(req,res,next)=>{try{
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<=0)throw fail(400,'Invalid clarification id.');
  const b=z.object({answer:z.string().min(1).max(3000).refine(v=>v.trim().length>0,'Answer cannot be empty.').optional(),resolved:z.boolean().optional()}).refine(v=>Object.keys(v).length>0,'Provide an answer or resolution state.').parse(req.body);
  if(b.resolved===true&&!b.answer)throw fail(400,'An answer is required to resolve a clarification.');
  const current=db.prepare('SELECT * FROM clarifications WHERE id=?').get(id);
  if(!current)throw fail(404,'Clarification not found.');
  const meetingId=current.meeting_id;
  const actionId=transaction(()=>{
    db.prepare('UPDATE clarifications SET answer=COALESCE(?,answer),resolved=COALESCE(?,resolved) WHERE id=?').run(b.answer??null,b.resolved===undefined?null:b.resolved?1:0,id);
    let linkedId=current.action_id!=null&&db.prepare('SELECT id FROM actions WHERE id=? AND meeting_id=?').get(current.action_id,meetingId)?current.action_id:null;
    if(linkedId==null&&current.related_title){
      const matches=db.prepare('SELECT id FROM actions WHERE meeting_id=? AND title=?').all(meetingId,current.related_title);
      if(matches.length===1){linkedId=matches[0].id;db.prepare('UPDATE clarifications SET action_id=? WHERE id=?').run(linkedId,id);}
    }
    if(linkedId!=null){
      db.prepare(`UPDATE actions SET needs_clarification=CASE WHEN EXISTS(SELECT 1 FROM clarifications WHERE action_id=? AND resolved=0) THEN 1 ELSE 0 END WHERE id=? AND meeting_id=?`).run(linkedId,linkedId,meetingId);
    }
    return linkedId;
  })();
  const clarification=db.prepare('SELECT * FROM clarifications WHERE id=?').get(id);
  res.json({clarification:{...clarification,resolved:!!clarification.resolved},meeting:report(meetingId),actionLinked:actionId!=null});
}catch(e){next(e);}});
app.patch('/api/decisions/:id',(req,res,next)=>{try{const b=z.object({title:z.string().min(1).max(500).optional(),description:z.string().max(3000).optional(),kind:z.enum(['confirmed','proposed','unresolved']).optional()}).parse(req.body);const x=db.prepare(`UPDATE decisions SET ${Object.keys(b).map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...Object.values(b),Number(req.params.id));if(!x.changes)throw fail(404,'Decision not found.');res.json({decision:db.prepare('SELECT * FROM decisions WHERE id=?').get(Number(req.params.id))});}catch(e){next(e);}});
app.patch('/api/followups/:id',(req,res,next)=>{try{const b=z.object({title:z.string().min(1).max(500).optional(),description:z.string().max(3000).optional(),owner:z.string().max(200).nullable().optional(),deadline:z.string().max(40).nullable().optional()}).parse(req.body);const x=db.prepare(`UPDATE followups SET ${Object.keys(b).map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...Object.values(b),Number(req.params.id));if(!x.changes)throw fail(404,'Follow-up not found.');res.json({followUp:db.prepare('SELECT * FROM followups WHERE id=?').get(Number(req.params.id))});}catch(e){next(e);}});
app.get('/api/dashboard',(_q,res)=>{const get=s=>db.prepare(s).get().n;res.json({meetings:get('SELECT count(*) n FROM meetings'),actions:get('SELECT count(*) n FROM actions'),pending:get("SELECT count(*) n FROM actions WHERE status!='completed'"),completed:get("SELECT count(*) n FROM actions WHERE status='completed'"),clarifications:get('SELECT count(*) n FROM clarifications WHERE resolved=0'),upcoming:get("SELECT count(*) n FROM actions WHERE deadline>=date('now') AND status!='completed'"),recent:db.prepare('SELECT m.id,m.title,m.meeting_date,m.summary,(SELECT count(*) FROM actions a WHERE a.meeting_id=m.id) action_count FROM meetings m ORDER BY m.created_at DESC LIMIT 5').all()});});
app.use((e,req,res,_next)=>{
  const status=e.status||((e instanceof z.ZodError)?400:500);
  const requestId=randomUUID();
  const validation=safeValidationIssues(e);
  const omittedValues=[config.groqApiKey,req.body?.transcript];
  const publicDetail=safeErrorDetail(e,omittedValues);
  const detail=validation||publicDetail;
  console.error('[meetmind-api]',JSON.stringify({event:'request_failed',requestId,method:req.method,path:req.path,status,provider:config.aiProvider,model:config.groqModel,errorName:e.name||'Error',code:e.code||e.cause?.code||null,detail}));
  const message=status===400?'Please check the submitted fields and try again.':e.status?publicDetail:'Analysis failed unexpectedly. Please retry and provide this reference if it continues.';
  res.status(status).json({error:message,requestId,details:validation});
});
app.listen(config.port,()=>console.log(`MeetMind API listening on http://localhost:${config.port}`));

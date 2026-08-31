import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeDataRoot, openDatabase } from '../src/db.js';
import { changeOrganization, readOrganization } from '../src/session/organization.js';
import { matchRoute, SCOPES } from '../src/control/contract.js';

function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wave-organizer-'));
 const paths=initializeDataRoot(dir), db=openDatabase(paths.database);
 db.exec("INSERT INTO projects(id,name,repo_path,integration_branch,created_at) VALUES ('p','P','unused','main','now')");
 for(const [id,state] of [['done','COMPLETED'],['live','WORKING'],['waiting','WAITING_FOR_HERMES']])
   db.prepare('INSERT INTO autonomous_sessions(id,project_id,intent,mode,state,created_at,updated_at) VALUES (?,?,?, ?,?,?,?)').run(id,'p','original task','MANUAL',state,'now','now');
 t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true})});return {db,paths};
}
test('organization does not modify original intent; archive/restore/delete require safe order',t=>{
 const {db}=fixture(t);
 changeOrganization(db,{action:'rename',sessionId:'done',name:'My wave'});
 assert.equal(db.prepare("SELECT intent FROM autonomous_sessions WHERE id='done'").get().intent,'original task');
 for(const id of ['live','waiting'])assert.throws(()=>changeOrganization(db,{action:'archive',sessionId:id}),/Finish or stop/);
 assert.throws(()=>changeOrganization(db,{action:'delete',sessionId:'done',confirm:true}),/Archive/);
 changeOrganization(db,{action:'archive',sessionId:'done'});
 changeOrganization(db,{action:'restore',sessionId:'done'});
 assert.equal(readOrganization(db).waves[0].archived_at,null);
 changeOrganization(db,{action:'archive',sessionId:'done'});
 assert.throws(()=>changeOrganization(db,{action:'delete',sessionId:'done'}),/confirm/);
 changeOrganization(db,{action:'delete',sessionId:'done',confirm:true});
 const stored=readOrganization(db);
 changeOrganization(db,{action:'delete',sessionId:'done',confirm:true});
 assert.deepEqual(readOrganization(db),stored);
 assert.throws(()=>changeOrganization(db,{action:'restore',sessionId:'done'}),/deleted/);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM autonomous_sessions').get().n,3);
});
test('custom groups and movement persist on a fresh database handle; removal preserves waves',t=>{
 const {db,paths}=fixture(t);
 const group=changeOrganization(db,{action:'group.create',name:'Real work'}).groups[0];
 changeOrganization(db,{action:'move',sessionId:'done',groupId:group.id});
 changeOrganization(db,{action:'group.rename',groupId:group.id,name:'Renamed'});
 const reopened=openDatabase(paths.database);
 assert.equal(readOrganization(reopened).groups[0].name,'Renamed');reopened.close();
 assert.throws(()=>changeOrganization(db,{action:'move',sessionId:'done',groupId:'missing'}),/Unknown/);
 changeOrganization(db,{action:'group.delete',groupId:group.id});
 assert.equal(readOrganization(db).waves[0].group_id,null);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM autonomous_sessions').get().n,3);
});
test('organization mutation route requires operator authority',()=>{
 assert.equal(matchRoute('POST','/v1/wave-organization').scope,SCOPES.OPERATE);
 assert.equal(matchRoute('GET','/v1/wave-organization').scope,SCOPES.READ);
});

test('terminal session cannot hide an unfinished child attempt or commission',t=>{
 const {db}=fixture(t);
 for(const [id,parent] of [['root',null],['child','root']])
   db.prepare("INSERT INTO jobs(id,project_id,goal,mode,status,base_sha,target_branch,parent_job_id,created_at,updated_at) VALUES (?,'p','task','read','FAILED','base','main',?,'now','now')").run(id,parent);
 db.exec("UPDATE autonomous_sessions SET job_id='root',state='FAILED' WHERE id='done'");
 db.exec("INSERT INTO attempts(id,job_id,ordinal,scheduler_epoch,backend,started_at) VALUES ('a','child',1,1,'test','now')");
 assert.throws(()=>changeOrganization(db,{action:'archive',sessionId:'done'}),/workers/);
 db.exec("UPDATE attempts SET terminal_state='FAILED' WHERE id='a'");
 db.exec("INSERT INTO work_commissions(id,job_id,action,state,created_at,updated_at) VALUES ('c','child','IMPLEMENT','PENDING','now','now')");
 assert.throws(()=>changeOrganization(db,{action:'archive',sessionId:'done'}),/workers/);
 db.exec("UPDATE work_commissions SET state='FAILED' WHERE id='c'");
 changeOrganization(db,{action:'archive',sessionId:'done'});
 assert.ok(readOrganization(db).waves[0].archived_at);
});

test('schema 37 upgrade preserves sessions and initializes empty organization',t=>{
 const {db,paths}=fixture(t);
 db.exec("DROP TABLE wave_organization; DROP TABLE wave_groups; UPDATE metadata SET value='37' WHERE key='schema_version'");
 const upgraded=openDatabase(paths.database);
 assert.deepEqual(readOrganization(upgraded),{groups:[],waves:[]});
 assert.equal(upgraded.prepare('SELECT COUNT(*) n FROM autonomous_sessions').get().n,3);
 assert.equal(upgraded.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,'38');
 upgraded.close();
});

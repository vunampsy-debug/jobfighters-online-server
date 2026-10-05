'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const WebSocket=require('ws');
test('valid fight and terminal snapshots relay without emitting a spurious roomError',async()=>{
  const sockets=[];let server;
  try{
    server=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,PORT:'0'}});
    const url=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Startup timeout')),5000);server.stdout.on('data',b=>{const m=/http:\/\/localhost:(\d+)/.exec(b.toString());if(m){clearTimeout(t);resolve(`ws://localhost:${m[1]}`);}});server.once('error',reject);});
    async function client(){
      const ws=new WebSocket(url),queue=[],waiters=[];sockets.push(ws);
      ws.on('message',b=>{queue.push(JSON.parse(b));for(const w of [...waiters]){const i=queue.findIndex(m=>m.type===w.type&&w.predicate(m));if(i>=0){waiters.splice(waiters.indexOf(w),1);clearTimeout(w.timer);w.resolve(queue.splice(i,1)[0]);}}});
      const c={queue,send(type,p={}){ws.send(JSON.stringify({type,...p}));},wait(type,predicate=()=>true){const i=queue.findIndex(m=>m.type===type&&predicate(m));if(i>=0)return Promise.resolve(queue.splice(i,1)[0]);return new Promise((resolve,reject)=>{const w={type,predicate,resolve};w.timer=setTimeout(()=>reject(Error(`Timeout ${type}`)),3000);waiters.push(w);});}};
      await c.wait('connected');return c;
    }
    for(const slots of [2,4]){
      const host=await client();host.send('createRoom',{maxPlayers:slots});const room=await host.wait('roomCreated');const all=[host];
      for(let n=1;n<slots;n++){const g=await client();g.send('joinRoom',{code:room.code});await g.wait('joined');all.push(g);}
      host.send('setRules',{rules:{timeLimit:99,healthBars:3,roundLimit:3}});await all[1].wait('rules');
      const ids=['doctor','teacher','engineer','chef'];
      for(let n=0;n<slots;n++){all[n].send('selectCharacter',{characterId:ids[n],playerNumber:n+1});await all[n].wait('pick',m=>m.player===n+1);all[n].send('playerReady',{ready:true});await all[n].wait('roomStatus',m=>m.roster.some(p=>p.playerNumber===n+1&&p.ready));}
      host.send('startMatch',{stage:'classroom',currentRound:1});const start=await host.wait('startMatch');await Promise.all(all.slice(1).map(c=>c.wait('startMatch')));
      for(const state of ['fight','roundOver']){
        await new Promise(r=>setTimeout(r,20));const snapshot={state};for(let n=1;n<=slots;n++)snapshot[`p${n}`]={health:100};
        host.send('state',{matchId:start.matchId,frame:state==='fight'?1:2,snapshot});
        for(const g of all.slice(1))assert.equal((await g.wait('state')).snapshot.state,state);
        host.send('ping',{t:42});await host.wait('pong');assert.equal(host.queue.filter(m=>m.type==='roomError').length,0);
      }
      host.send('roundResult',{matchId:start.matchId,currentRound:1,winner:'Player 1',p1RoundWins:1,p2RoundWins:0});
      for(const g of all.slice(1))assert.equal((await g.wait('roundResult')).final,false);
      host.send('startMatch',{stage:'classroom',currentRound:2});const next=await host.wait('startMatch');assert.notEqual(next.matchId,start.matchId);
      assert.equal(next.p1RoundWins,1);assert.equal(next.currentRound,2);
    }
  }finally{for(const s of sockets)s.terminate();if(server)server.kill();}
});

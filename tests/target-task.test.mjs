import test from 'node:test';
import assert from 'node:assert/strict';
import {Session, TARGETS, DURATION, CONTACT_RADIUS} from '../dist/lib/target-task.js';
import {DT} from '../dist/lib/model.js';

function near(actual, expected, tolerance=1e-9) {
  assert.ok(Math.abs(actual-expected)<=tolerance, `${actual} differs from ${expected}`);
}

function complete(session) {
  let remaining=Math.ceil(DURATION/DT)+2;
  while(!session.finished && remaining-->0)session.tick();
  assert.ok(session.finished, 'A trial must finish within its model-time limit');
  return session.records.at(-1);
}

function until(session, seconds) {
  while(!session.finished && session.state.time<seconds-1e-9)session.tick();
  assert.ok(!session.finished, `Trial unexpectedly finished before ${seconds} seconds`);
}

function finiteNumbers(value) {
  if(typeof value==='number')assert.ok(Number.isFinite(value), `Non-finite exported value: ${value}`);
  else if(Array.isArray(value))value.forEach(finiteNumbers);
  else if(value && typeof value==='object')Object.values(value).forEach(finiteNumbers);
}

test('clean left/right trials reproduce the unmodified model and mirrored trajectories', () => {
  const session=new Session();
  const left=complete(session);
  session.next();
  const right=complete(session);
  assert.equal(left.result, 'Reached');
  assert.equal(right.result, 'Reached');
  near(left.firstContactSeconds, 7.76);
  near(right.firstContactSeconds, 7.76);
  near(left.pathLength, .4945, .0001);
  near(left.pathLength, right.pathLength);
  assert.equal(left.samples.length, right.samples.length);
  for(let i=0;i<left.samples.length;i++) {
    const a=left.samples[i], b=right.samples[i];
    near(a.x+b.x, 1);
    near(a.y, b.y);
    near(a.rates[0], b.rates[1]);
    near(a.rates[5], b.rates[6]);
  }
  for(const record of [left,right]) {
    const last=record.samples.at(-1);
    assert.ok(Math.hypot(last.x-record.finalTarget.x,last.y-record.finalTarget.y)<=CONTACT_RADIUS+1e-10);
    const preceding=record.samples.findLast(sample=>sample.t<last.t);
    assert.ok(Math.hypot(preceding.x-record.finalTarget.x,preceding.y-record.finalTarget.y)>CONTACT_RADIUS);
  }
  assert.deepEqual(session.summary(), {completed:2,reached:2,meanContactSeconds:7.76});
});

test('hiding the input before any tick produces no motion and a timeout excluded from standard counts', () => {
  const session=new Session();
  session.toggleInput();
  const record=complete(session);
  assert.equal(record.result,'Timed out');
  assert.equal(record.duration,30);
  assert.equal(record.firstContactSeconds,null);
  assert.equal(record.standard,false);
  assert.equal(record.pathLength,0);
  for(const sample of record.samples) {
    assert.equal(sample.x,.5);
    assert.equal(sample.y,.75);
    assert.deepEqual(sample.rates,[0,0,0,0,0,0,0,0]);
  }
  assert.deepEqual(session.summary(),{completed:0,reached:0,meanContactSeconds:null});
});

test('every reversal trial executes its scheduled change exactly once at four model seconds', () => {
  const session=new Session();
  session.next('reversal');
  for(let index=0;index<TARGETS.length;index++) {
    const record=complete(session);
    const changes=session.events.filter(event=>event.trial===record.trial && event.kind==='stimulus');
    assert.equal(changes.length,1,`Target ${index} must experience the reversal before completion`);
    assert.equal(changes[0].t,4);
    assert.equal(record.targetIndex,index);
    assert.notEqual(record.finalTarget.x,record.initialTarget.x);
    assert.ok(record.duration>=4);
    if(index<TARGETS.length-1)session.next();
  }
});

test('the 3–8 second occlusion removes drive, allows state decay, and recovers after input returns', () => {
  const session=new Session();
  session.next('occlusion');
  until(session,3);
  const before=Array.from(session.state.rates);
  assert.ok(before[0]+before[1]>.1);
  until(session,7.9);
  const hidden=Array.from(session.state.rates);
  assert.equal(session.hidden,true);
  assert.equal(session.state.features.left,0);
  assert.equal(session.state.features.right,0);
  assert.ok(hidden[0]+hidden[1]<(before[0]+before[1])*.001);
  assert.ok(hidden[7]<before[7]*.01);
  until(session,8.6);
  assert.equal(session.hidden,false);
  assert.ok(session.state.rates[0]+session.state.rates[1]>.1);
  assert.ok(session.state.rates[7]>hidden[7]+.01);
  const record=complete(session);
  const changes=session.events.filter(event=>event.trial===record.trial && event.kind==='stimulus');
  assert.deepEqual(changes.map(event=>[event.t,event.detail]),[[3,'Visual input off'],[8,'Visual input on']]);
  assert.equal(record.standard,true);
  assert.equal(record.result,'Reached');
  near(record.firstContactSeconds,12.72);
});

test('observer interventions and interrupted runs cannot improve aggregate success counts', () => {
  const session=new Session();
  complete(session);
  const cleanSummary=session.summary();
  session.next();
  session.moveTarget(session.state.target.x,session.state.target.y);
  const intervened=complete(session);
  assert.equal(intervened.result,'Reached');
  assert.equal(intervened.standard,false);
  assert.deepEqual(session.summary(),cleanSummary);
  session.next();
  until(session,.5);
  session.next();
  assert.equal(session.records.at(-1).result,'Interrupted');
  assert.equal(session.records.at(-1).standard,false);
  assert.deepEqual(session.summary(),cleanSummary);
  session.next('occlusion');
  assert.deepEqual(session.summary(),{completed:0,reached:0,meanContactSeconds:null});
});

test('protocol target order repeats without carrying motor state between trials', () => {
  const session=new Session();
  for(let index=0;index<=TARGETS.length;index++) {
    assert.equal(session.targetIndex,index%TARGETS.length);
    assert.deepEqual(session.state.target,TARGETS[index%TARGETS.length]);
    assert.equal(session.state.time,0);
    assert.deepEqual(Array.from(session.state.rates),[0,0,0,0,0,0,0,0]);
    assert.equal(session.state.fish.x,.5);
    assert.equal(session.state.fish.y,.75);
    complete(session);
    if(index<TARGETS.length)session.next();
  }
  session.next('occlusion');
  assert.equal(session.targetIndex,0);
  session.next('reach');
  assert.equal(session.targetIndex,1);
});

test('export JSON contains finite numbers and the completed trace ends at its scored state', () => {
  const session=new Session();
  complete(session);
  const raw=session.export();
  finiteNumbers(raw);
  const parsed=JSON.parse(JSON.stringify(raw));
  assert.equal(parsed.current,null);
  assert.equal(parsed.model.trained,false);
  const record=parsed.trials.at(-1), sample=record.samples.at(-1), trace=session.trace.at(-1);
  assert.equal(sample.t,record.duration);
  assert.equal(sample.path,record.pathLength);
  near(sample.x,session.state.fish.x);
  near(sample.y,session.state.fish.y);
  near(trace.x,sample.x);
  near(trace.y,sample.y);
  assert.equal(parsed.events.at(-1).t,record.duration);
  assert.equal(parsed.events.at(-1).detail,record.result);
  for(let i=1;i<record.samples.length;i++) {
    assert.ok(record.samples[i].t>=record.samples[i-1].t);
    assert.ok(record.samples[i].path>=record.samples[i-1].path);
  }
  session.next();
  until(session,.24);
  const active=session.export();
  finiteNumbers(active);
  const activeParsed=JSON.parse(JSON.stringify(active));
  near(activeParsed.current.snapshot.t,.24);
  assert.ok(activeParsed.current.samples.at(-1).t<=activeParsed.current.snapshot.t);
  assert.equal(activeParsed.current.manual,false);
});

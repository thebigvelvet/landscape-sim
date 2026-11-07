// Round 12: timelapse mode. A new map starts frozen; a timelapse runs a chosen span over a chosen
// watch length, lands exactly on the end day and freezes there.
//   electron tools/review --name=tl --dist=<dist> --out=<dir> --eval=tests/timelapse.js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const e = sim.engine, R = { checks: {} };
const check = (name, pass, data) => { R.checks[name] = { pass: !!pass, ...data }; };
const $ = (id) => document.getElementById(id);
const waitDone = async (maxMs) => {
  const t0 = performance.now();
  while (sim.timelapseState().tl && performance.now() - t0 < maxMs) await sleep(50);
  return (performance.now() - t0) / 1000;
};

// 1. A new landscape starts frozen
await sim.load('random', { size: 512, seed: 3, preset: 'Colorado alpine' });
const d0 = e.day;
await sleep(2000);
check('loadsPaused', e.paused && e.day === d0, { paused: e.paused, day0: d0, dayAfter2s: e.day });
check('startButtonShown', $('tl-icon-play').style.display !== 'none' && $('tl-stop').hidden && $('tl-progress').hidden, {});

// 2. 10 years over 5 s lands exactly on the end day and freezes
{
  const tl = sim.timelapse(3650, 5);
  await sleep(300);
  const midShown = !$('tl-progress').hidden && !$('tl-stop').hidden && /of 10/.test($('tl-progress-text').textContent);
  const secs = 0.3 + await waitDone(30000);
  await sleep(500);
  const st = await sim.stats();
  check('tenYearsEndsExactly', Math.abs(e.day - tl.endDay) < 1e-3 && e.paused && e.stopAtDay === null,
    { day: e.day, endDay: tl.endDay, paused: e.paused, secs });
  check('tenYearsTookAboutFiveSeconds', secs > 3.5 && secs < 9, { secs });
  check('progressShownWhileRunning', midShown, { text: $('tl-progress-text').textContent });
  check('frozenAfterEnd', e.day === tl.endDay && (await sleep(1000), e.day === tl.endDay), { day: e.day });
  check('toastAtEnd', /Timelapse done/.test($('toast').textContent), { toast: $('toast').textContent.slice(0, 120) });
  check('booksAfterTimelapse', !st.hasNaN && Math.abs(st.balanceErrorPct) < 0.01, { balPct: st.balanceErrorPct });
}

// 3. A week over 10 s runs in slow motion and still ends exactly
{
  const start = e.day;
  const tl = sim.timelapse(7, 10);
  await sleep(2000);
  const speed = e.speed, part = e.day - start;
  const secs = 2 + await waitDone(30000);
  check('weekIsSlowMotion', speed < 1 && part > 0.5 && part < 3, { speed, daysAfter2s: part });
  check('weekEndsExactly', Math.abs(e.day - tl.endDay) < 1e-6 && e.paused, { day: e.day, endDay: tl.endDay, secs });
}

// 4. 100,000 years over 15 s runs at top speed; Stop part-way keeps the day and freezes
{
  const tl = sim.timelapse(36500000, 15);
  check('longSpanCappedAtTopSpeed', e.speed === 365000, { speed: e.speed });
  await sleep(2500);
  sim.stopTimelapse();
  const dStop = e.day;
  await sleep(1000);
  check('stopKeepsDayAndFreezes', e.paused && e.day === dStop && dStop > tl.startDay && !sim.timelapseState().tl && e.stopAtDay === null,
    { dStop, after: e.day, paused: e.paused });
}

// 5. Pause and resume keep the end point; strobe carry does not overshoot
{
  const tl = sim.timelapse(365 * 50, 4);
  await sleep(1000);
  sim.pause();
  const dp = e.day;
  await sleep(800);
  const heldWhilePaused = e.day === dp && sim.timelapseState().tl !== null;
  sim.play();
  await waitDone(20000);
  check('pauseResumeKeepsEnd', heldWhilePaused && Math.abs(e.day - tl.endDay) < 1e-3 && e.paused, { dp, day: e.day, endDay: tl.endDay });
}

// 6. Free run ends a timelapse; a speed change from the free-run slider does too
{
  sim.timelapse(365000, 30);
  await sleep(500);
  sim.freeRun();
  const a = sim.timelapseState();
  await sleep(500);
  check('freeRunCancelsTimelapse', !a.tl && a.stopAtDay === null && !e.paused, {});
  sim.pause();
  sim.timelapse(365000, 30);
  sim.setSpeed(365);
  const b = sim.timelapseState();
  check('speedSliderCancelsTimelapse', !b.tl && b.stopAtDay === null, {});
  sim.pause();
}

// 7. The UI: Start button, space bar, estimate warning, Stop button, a new map ends any timelapse
{
  $('tl-span').value = '36500000'; $('tl-span').dispatchEvent(new Event('change'));
  document.querySelector('#tl-watch button[data-sec="15"]').click();
  const est = $('tl-estimate').textContent;
  check('estimateWarnsTooLong', /Too long/.test(est) && /1 min 40 s/.test(est), { est });
  $('tl-span').value = '3650'; $('tl-span').dispatchEvent(new Event('change'));
  const start = e.day;
  $('tl-go').click();
  await sleep(500);
  const s1 = sim.timelapseState();
  const controlsLocked = $('tl-span').disabled;
  document.activeElement?.blur?.();
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
  const pausedBySpace = e.paused;
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
  const resumedBySpace = !e.paused;
  $('tl-stop').click();
  check('uiStartPauseStop', s1.tl && s1.tl.days === 3650 && s1.tl.watchSec === 15 && controlsLocked && pausedBySpace && resumedBySpace
    && e.paused && !sim.timelapseState().tl && !$('tl-span').disabled && e.day > start, { s1 });
  // during free run, one press of Start switches straight to the timelapse
  sim.freeRun(); await sleep(200);
  $('tl-go').click(); await sleep(200);
  const s2 = sim.timelapseState();
  check('startFromFreeRunOnePress', !!s2.tl && !e.paused, { s2 });
  sim.stopTimelapse();
  sim.timelapse(365000, 30);
  await sim.load('random', { size: 256, seed: 2 });
  check('newMapEndsTimelapse', !sim.timelapseState().tl && e.paused && e.stopAtDay === null, {});
}

R.gpuErrors = window.__gpuErrors || 0;
check('noGpuErrors', R.gpuErrors === 0, { msgs: window.__gpuErrorMsgs });
R.passed = Object.values(R.checks).filter((q) => q.pass).length + '/' + Object.keys(R.checks).length;
try { localStorage.clear(); } catch {}
return R;

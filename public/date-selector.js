// v16 §1 — THE ONE reusable date selector used everywhere in admin
// (Run History, Daily Review, Performance, Studio). Segmented
// [ Yesterday | Today | Custom 📅 ] control. Every option fires `onChange`
// synchronously and immediately — no page needs its own bespoke date input,
// and no view is left showing stale data because a change event never fired.
'use strict';

function localDateStr(offsetDays) {
  return new Date(Date.now() + (offsetDays || 0) * 86400000).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}

// Renders into `elOrId` (an element or element id). opts:
//   value:    the currently-selected date string ('YYYY-MM-DD')
//   onChange: fn(dateStr) — called immediately whenever the selection changes
function renderDateSelector(elOrId, opts) {
  const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
  if (!el) return;
  const yesterday = localDateStr(-1), today = localDateStr(0);
  const current = opts.value || yesterday;
  const mode = current === yesterday ? 'yesterday' : current === today ? 'today' : 'custom';

  el.innerHTML = `<div class="date-sel">
    <button type="button" class="date-sel-btn ${mode === 'yesterday' ? 'active' : ''}" data-mode="yesterday">Yesterday</button>
    <button type="button" class="date-sel-btn ${mode === 'today' ? 'active' : ''}" data-mode="today">Today</button>
    <button type="button" class="date-sel-btn ${mode === 'custom' ? 'active' : ''}" data-mode="custom">📅 ${mode === 'custom' ? current : 'Custom'}</button>
    <input type="date" class="date-sel-input" style="display:none">
  </div>`;

  const input = el.querySelector('.date-sel-input');
  input.value = current;
  el.querySelectorAll('.date-sel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = btn.dataset.mode;
      if (m === 'yesterday') { opts.onChange(yesterday); renderDateSelector(el, { ...opts, value: yesterday }); }
      else if (m === 'today') { opts.onChange(today); renderDateSelector(el, { ...opts, value: today }); }
      else {
        input.style.display = 'inline-block';
        if (input.showPicker) { try { input.showPicker(); } catch (_) {} }
        input.focus();
      }
    });
  });
  input.addEventListener('change', () => {
    if (input.value) { opts.onChange(input.value); renderDateSelector(el, { ...opts, value: input.value }); }
  });
}

// v17 §2 — ONE shared loading-state pattern, reused by every async button
// and every date/tab content switch across Generator, History, Review,
// Performance, and Studio — no page builds its own spinner/skeleton.

// Button loading: swaps the label for a spinner + text, disables the
// button, and returns restore(errorText) to call when the action settles.
// Pass an error message to restore() to flash it briefly instead of just
// reverting silently — an action that fails must never look like nothing
// happened.
function genLoadingButton(btn, loadingText) {
  if (!btn) return () => {};
  const origHtml = btn.innerHTML, origDisabled = btn.disabled;
  btn.disabled = true;
  btn.innerHTML = `<span class="gen-spinner"></span> ${loadingText || 'Loading…'}`;
  return function restore(errorText) {
    if (errorText) {
      btn.innerHTML = `⚠ ${errorText}`;
      setTimeout(() => { btn.innerHTML = origHtml; btn.disabled = origDisabled; }, 2500);
    } else {
      btn.innerHTML = origHtml;
      btn.disabled = origDisabled;
    }
  };
}

// Content-area loading: replaces a container's content with a pulsing
// skeleton the INSTANT a date/tab switch starts, so the gap between
// "clicked" and "real data rendered" is never a blank, frozen-looking page.
function genLoadingSkeleton(elOrId, rows) {
  const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
  if (!el) return;
  const n = rows || 3;
  el.innerHTML = `<div class="gen-skel-wrap">${Array.from({ length: n }).map(() => '<div class="gen-skel-row"></div>').join('')}</div>`;
}

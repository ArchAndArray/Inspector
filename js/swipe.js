// Swipe-left-to-delete helper. Global `SwipeDelete`.
const SwipeDelete = (() => {
  const REVEAL = 88;
  const FULL = 220;
  let openHost = null;

  function injectCss() {
    if (document.getElementById('swipe-css')) return;
    const s = document.createElement('style');
    s.id = 'swipe-css';
    s.textContent = `
.swipe-host{position:relative;overflow:hidden;}
.swipe-host>.swipe-row{position:relative;z-index:1;touch-action:pan-y;transition:transform .2s ease;margin:0!important;}
.swipe-host.swipe-drag>.swipe-row{transition:none;}
.swipe-btn{position:absolute;top:0;bottom:0;right:0;width:${REVEAL}px;border:0;background:#d92d20;color:#fff;font-weight:600;font-size:15px;z-index:0;cursor:pointer;}
.swipe-modal{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;display:flex;align-items:center;justify-content:center;padding:24px;}
.swipe-modal-box{background:#fff;color:#111;border-radius:14px;max-width:360px;width:100%;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.3);}
.swipe-modal-box h3{margin:0 0 8px;font-size:18px;}
.swipe-modal-box p{margin:0 0 18px;font-size:14px;line-height:1.4;color:#444;white-space:pre-line;}
.swipe-modal-actions{display:flex;gap:10px;}
.swipe-modal-actions button{flex:1;padding:12px;border-radius:10px;border:1px solid #ccc;background:#f4f4f4;font-size:15px;font-weight:600;cursor:pointer;}
.swipe-modal-actions .swipe-ok{background:#d92d20;border-color:#d92d20;color:#fff;}
@media (prefers-color-scheme:dark){.swipe-modal-box{background:#2a2a2e;color:#eee}.swipe-modal-box p{color:#bbb}.swipe-modal-actions button{background:#3a3a3f;border-color:#555;color:#eee}.swipe-modal-actions .swipe-ok{background:#d92d20;border-color:#d92d20;color:#fff}}
`;
    document.head.appendChild(s);
  }

  function confirmDialog(title, message, label) {
    injectCss();
    return new Promise((resolve) => {
      const m = document.createElement('div');
      m.className = 'swipe-modal';
      m.innerHTML = `<div class="swipe-modal-box" role="alertdialog"><h3></h3><p></p><div class="swipe-modal-actions"><button class="swipe-cancel">Cancel</button><button class="swipe-ok"></button></div></div>`;
      m.querySelector('h3').textContent = title || 'Delete?';
      m.querySelector('p').textContent = message || 'Are you sure? This can\'t be undone.';
      m.querySelector('.swipe-ok').textContent = label || 'Delete';
      const done = (v) => { m.remove(); resolve(v); };
      m.querySelector('.swipe-cancel').addEventListener('click', () => done(false));
      m.querySelector('.swipe-ok').addEventListener('click', () => done(true));
      m.addEventListener('click', (e) => { if (e.target === m) done(false); });
      document.body.appendChild(m);
    });
  }

  function setX(host, x, animate) {
    const row = host.firstElementChild;
    row.style.transform = x ? `translateX(${x}px)` : '';
    host._x = x;
    host.lastElementChild.style.visibility = x ? 'visible' : 'hidden';
  }
  function close(host) { if (host) { setX(host, 0); if (openHost === host) openHost = null; } }
  function closeAll() { close(openHost); }

  function attach(row, opts) {
    if (!row || row.parentNode == null || row.classList.contains('swipe-row')) return;
    injectCss();
    const cs = getComputedStyle(row);
    const host = document.createElement('div');
    host.className = 'swipe-host';
    host.style.margin = cs.margin;
    host.style.borderRadius = cs.borderRadius;
    if (cs.display === 'flex' || cs.display === 'grid') host.style.display = 'block';
    if (cs.flex && cs.flex !== '0 1 auto') host.style.flex = cs.flex;
    if (row.style.display === 'none') host.style.display = 'none';
    row.parentNode.insertBefore(host, row);
    host.appendChild(row);
    row.classList.add('swipe-row');
    const btn = document.createElement('button');
    btn.className = 'swipe-btn';
    btn.type = 'button';
    btn.textContent = 'Delete';
    btn.style.visibility = 'hidden';
    host.appendChild(btn);
    host._x = 0;

    const ask = async () => {
      const ok = await confirmDialog(opts.title, opts.message, opts.label);
      if (!ok) { close(host); return; }
      close(host);
      try { await opts.onDelete(); } catch (e) { console.error(e); }
    };
    btn.addEventListener('click', (e) => { e.stopPropagation(); ask(); });

    let sx = 0, sy = 0, base = 0, mode = null, id = null, moved = false;
    row.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('input,select,textarea')) return;
      if (openHost && openHost !== host) closeAll();
      sx = e.clientX; sy = e.clientY; base = host._x || 0; mode = null; id = e.pointerId; moved = false;
    });
    row.addEventListener('pointermove', (e) => {
      if (id !== e.pointerId) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!mode) {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          mode = 'h'; host.classList.add('swipe-drag');
          try { row.setPointerCapture(id); } catch (_) {}
        } else if (Math.abs(dy) > 10) { mode = 'v'; id = null; return; }
        else return;
      }
      moved = true;
      let x = Math.min(0, Math.max(-(FULL + 40), base + dx));
      setX(host, x);
      btn.style.width = Math.max(REVEAL, -x) + 'px';
      e.preventDefault();
    });
    const end = (e) => {
      if (id !== e.pointerId || mode !== 'h') { id = null; return; }
      id = null;
      host.classList.remove('swipe-drag');
      const x = host._x || 0;
      if (-x >= FULL) { setX(host, 0); btn.style.width = ''; ask(); return; }
      if (-x > REVEAL / 2) { setX(host, -REVEAL); btn.style.width = ''; openHost = host; }
      else { setX(host, 0); btn.style.width = ''; if (openHost === host) openHost = null; }
    };
    row.addEventListener('pointerup', (e) => { end(e); setTimeout(() => { moved = false; }, 350); });
    row.addEventListener('pointercancel', end);
    // Suppress click after a swipe or while open.
    host.addEventListener('click', (e) => {
      if (e.target === btn) return;
      if (moved) {
        e.stopPropagation(); e.preventDefault();
        moved = false;
      } else if (host._x) {
        e.stopPropagation(); e.preventDefault();
        close(host);
      }
    }, true);
  }

  // Attach to every element matching selector within root. resolver(el) -> opts or null.
  function attachAll(root, selector, resolver) {
    (root || document).querySelectorAll(selector).forEach((el) => {
      if (el.classList.contains('swipe-row')) return;
      const o = resolver(el);
      if (o) attach(el, o);
    });
  }

  document.addEventListener('pointerdown', (e) => {
    if (openHost && !openHost.contains(e.target)) closeAll();
  }, true);

  return { attach, attachAll, confirm: confirmDialog, closeAll };
})();
if (typeof window !== 'undefined') window.SwipeDelete = SwipeDelete;

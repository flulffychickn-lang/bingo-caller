(() => {
  'use strict';

  const STORAGE_KEY = 'billTrackerV4';
  const CATEGORIES = ['Water','Electricity','Internet','Car Expenses','Food','Others'];

  const money = n => new Intl.NumberFormat('en-PH', {style:'currency', currency:'PHP'}).format(Number(n) || 0);
  const uid = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
  const pad = n => String(n).padStart(2, '0');
  const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
  const monthKey = date => String(date || '').slice(0, 7);
  const monthLabel = key => { if (!/^\d{4}-\d{2}$/.test(key)) return key || ''; const [y,m] = key.split('-'); return new Date(Number(y), Number(m)-1, 1).toLocaleString('en-US', {month:'long', year:'numeric'}); };
  const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\'':'&#039;','"':'&quot;'}[c]));
  const fmtDate = d => d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-PH', {month:'short', day:'numeric', year:'numeric'}) : '—';
  const fmtDateLong = d => d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', {day:'2-digit', month:'short', year:'numeric'}) : '';
  const isCashSource = value => /cash/i.test(String(value || ''));

  const defaultState = () => ({
    version: 4,
    settings: { categories: [...CATEGORIES], defaultMonth: monthKey(localToday()) },
    banks: [],
    bills: [],
    bankTransactions: [],
    withdrawals: [],
    cashAdjustments: []
  });

  let state = loadState();
  let editor = null;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normalize(JSON.parse(raw));
      const v3 = localStorage.getItem('billTrackerV3');
      if (v3) return normalize(JSON.parse(v3));
      const v2 = localStorage.getItem('billTrackerV2');
      if (v2) return normalize(JSON.parse(v2));
      const v1 = localStorage.getItem('billTrackerV1');
      if (v1) return migrateOldState(JSON.parse(v1));
      return defaultState();
    } catch { return defaultState(); }
  }

  function migrateOldState(old) {
    const s = defaultState();
    s.settings.defaultMonth = old?.settings?.defaultMonth || s.settings.defaultMonth;
    s.banks = Array.isArray(old?.banks) ? old.banks : [];
    s.bankTransactions = Array.isArray(old?.bankTransactions) ? old.bankTransactions : [];
    s.withdrawals = Array.isArray(old?.withdrawals) ? old.withdrawals : [];
    const oldBills = Array.isArray(old?.bills) ? old.bills : [];
    const oldExpenses = Array.isArray(old?.expenses) ? old.expenses : [];
    s.bills = oldBills.map(b => ({
      id:b.id || uid('bill'), name:b.name || 'Untitled', category:b.category || 'Others', amount:Number(b.amount)||0,
      dueDate:b.dueDate || localToday(), status:b.status || (b.paid ? 'Paid' : 'Unpaid'), paidDate:b.paidDate || (b.paid ? b.dueDate : ''),
      paymentSource:b.paymentSource || (b.withdrawalId ? 'Cash' : 'Other'), notes:b.notes || ''
    }));
    oldExpenses.forEach(e => s.bills.push({
      id:e.id || uid('bill'), name:e.description || 'Expense', category:e.category || 'Others', amount:Number(e.amount)||0,
      dueDate:e.date || localToday(), status:'Paid', paidDate:e.date || localToday(), paymentSource:e.paymentSource || 'Other', notes:e.notes || ''
    }));
    return normalize(s);
  }

  function normalize(s) {
    const d = defaultState(); s = s && typeof s === 'object' ? s : {};
    const bills = Array.isArray(s.bills) ? s.bills.map(b => ({
      id:b.id || uid('bill'), name:String(b.name || b.description || 'Untitled'), category:b.category || 'Others', amount:Number(b.amount)||0,
      dueDate:b.dueDate || b.date || localToday(), status:b.status || (b.paid ? 'Paid' : 'Unpaid'), paidDate:b.paidDate || (b.paid ? (b.dueDate || b.date || '') : ''),
      paymentSource:String(b.paymentSource || 'Other'), notes:String(b.notes || '')
    })) : [];
    return {
      ...d, ...s,
      version:4,
      settings:{...d.settings,...(s.settings || {})},
      banks:Array.isArray(s.banks) ? s.banks.map(b => ({...b, name:String(b.name || 'Bank'), startingBalance:Number(b.startingBalance)||0})) : [],
      bills,
      bankTransactions:Array.isArray(s.bankTransactions) ? s.bankTransactions.map(t => ({
        ...t,
        type:['deposit','withdrawal','transfer'].includes(t.type) ? t.type : 'withdrawal',
        amount:Number(t.amount)||0,
        bankId:String(t.bankId || ''),
        fromBankId:String(t.fromBankId || ''),
        toBankId:String(t.toBankId || '')
      })) : [],
      withdrawals:Array.isArray(s.withdrawals) ? s.withdrawals.map(w => ({...w, amount:Number(w.amount)||0})) : [],
      cashAdjustments:Array.isArray(s.cashAdjustments) ? s.cashAdjustments.map(a => ({...a, amount:Number(a.amount)||0})) : []
    };
  }

  function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); renderAll(); }
  function persistOnly() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

  function bankBalance(bankId) {
    const bank = state.banks.find(b => b.id === bankId); if (!bank) return 0;
    let bal = Number(bank.startingBalance) || 0;
    state.bankTransactions.forEach(t => {
      const amount = Number(t.amount) || 0;
      if (t.type === 'deposit' && t.bankId === bankId) bal += amount;
      else if (t.type === 'withdrawal' && t.bankId === bankId) bal -= amount;
      else if (t.type === 'transfer') {
        if (t.fromBankId === bankId) bal -= amount;
        if (t.toBankId === bankId) bal += amount;
      }
    });
    state.withdrawals.filter(w => w.bankId === bankId).forEach(w => bal -= Number(w.amount)||0);
    return bal;
  }

  // Cash usage is automatically allocated to withdrawals in FIFO order by date.
  // Bills / expenses must simply use a Payment Source containing "Cash".
  function cashAllocationMap() {
    const remaining = state.withdrawals
      .map(w => ({id:w.id, date:String(w.date), remaining:Number(w.amount)||0}))
      .sort((a,b) => a.date.localeCompare(b.date));
    const allocations = {};
    const cashBills = state.bills
      .filter(b => b.status === 'Paid' && isCashSource(b.paymentSource))
      .sort((a,b) => String(a.paidDate || a.dueDate).localeCompare(String(b.paidDate || b.dueDate)));

    cashBills.forEach(b => {
      let need = Number(b.amount)||0;
      for (const w of remaining) {
        if (need <= 0) break;
        if (w.date > String(b.paidDate || b.dueDate)) continue;
        const take = Math.min(need, Math.max(0, w.remaining));
        if (take <= 0) continue;
        w.remaining -= take;
        need -= take;
        allocations[w.id] = (allocations[w.id] || 0) + take;
      }
    });
    return {allocations, remaining};
  }

  function withdrawalUsed(wid) { return cashAllocationMap().allocations[wid] || 0; }

  function cashWithdrawnTotal() {
    return state.withdrawals.reduce((s, w) => s + (Number(w.amount) || 0), 0);
  }

  function cashUsedTotal() {
    return state.bills
      .filter(b => b.status === 'Paid' && isCashSource(b.paymentSource))
      .reduce((s, b) => s + (Number(b.amount) || 0), 0);
  }

  function cashInHand() {
    let cash = state.withdrawals.reduce((s,w) => s + (Number(w.amount)||0), 0);
    cash -= state.bills.filter(b => b.status === 'Paid' && isCashSource(b.paymentSource)).reduce((s,b) => s + (Number(b.amount)||0), 0);
    state.cashAdjustments.forEach(a => cash += Number(a.amount)||0);
    return cash;
  }

  function totalBankBalance() { return state.banks.reduce((s,b) => s + bankBalance(b.id), 0); }
  function totalAvailable() { return totalBankBalance() + cashInHand(); }
  function isInMonth(date,m) { return monthKey(date) === m; }
  function paidBills(m) { return state.bills.filter(b => b.status === 'Paid' && isInMonth(b.paidDate || b.dueDate, m)); }
  function monthlyExpenses(m) { return paidBills(m).reduce((s,b) => s + (Number(b.amount)||0), 0); }
  function monthlyUnpaidBills(m) { return state.bills.filter(b => b.status !== 'Paid' && isInMonth(b.dueDate, m)).reduce((s,b) => s + (Number(b.amount)||0), 0); }
  function categoryTotals(m) {
    const out = {}; CATEGORIES.forEach(c => out[c] = 0);
    paidBills(m).forEach(b => out[b.category] = (out[b.category] || 0) + (Number(b.amount)||0));
    return out;
  }

  function applyTheme(theme) {
    const dark = theme === 'dark';
    document.body.classList.toggle('dark-theme', dark);
    const btn = document.getElementById('themeToggle');
    if (btn) {
      btn.textContent = dark ? '☀' : '☾';
      btn.setAttribute('aria-pressed', String(dark));
      btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
      btn.setAttribute('title', dark ? 'Switch to light theme' : 'Switch to dark theme');
    }
  }

  function initTheme() {
    const saved = localStorage.getItem('billTrackerTheme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(saved || (prefersDark ? 'dark' : 'light'));
  }

  function init() {
    initTheme();
    const baseMonth = state.settings.defaultMonth || monthKey(localToday());
    ['dashboardMonth','reportMonth'].forEach(id => document.getElementById(id).value = baseMonth);
    document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => switchSection(btn.dataset.section)));
    document.querySelectorAll('[data-go]').forEach(btn => btn.addEventListener('click', () => switchSection(btn.dataset.go)));
    document.getElementById('prevMonthBtn').addEventListener('click', () => shiftMonth('dashboardMonth', -1));
    document.getElementById('nextMonthBtn').addEventListener('click', () => shiftMonth('dashboardMonth', 1));
    document.getElementById('dashboardMonth').addEventListener('change', () => { state.settings.defaultMonth = document.getElementById('dashboardMonth').value; persistOnly(); renderAll(); });
    document.getElementById('dashboardMonthDisplay').addEventListener('click', () => openMonthPicker('dashboardMonth'));
    document.getElementById('reportMonth').addEventListener('change', renderAll);
    document.getElementById('reportMonthDisplay').addEventListener('click', () => openMonthPicker('reportMonth'));
    document.getElementById('addBillBtn').addEventListener('click', () => openBillModal());
    document.getElementById('addBankBtn').addEventListener('click', () => openBankModal());
    document.getElementById('addTransactionBtn').addEventListener('click', () => openBankTransactionModal());
    document.getElementById('addTransferBtn').addEventListener('click', () => openTransferModal());
    document.getElementById('addWithdrawalBtn').addEventListener('click', () => openWithdrawalModal());
    document.getElementById('billSearch').addEventListener('input', renderBills);
    document.getElementById('billStatusFilter').addEventListener('change', renderBills);
    document.getElementById('billCategoryFilter').addEventListener('change', renderBills);
    document.getElementById('exportBtn').addEventListener('click', exportBackup);
    document.getElementById('exportCsvBtn').addEventListener('click', exportExcelReport);
    document.getElementById('importInput').addEventListener('change', importBackup);
    document.getElementById('clearDataBtn').addEventListener('click', clearAllData);
    document.getElementById('themeToggle').addEventListener('click', () => { const next = document.body.classList.contains('dark-theme') ? 'light' : 'dark'; localStorage.setItem('billTrackerTheme', next); applyTheme(next); });
    document.getElementById('modalCloseBtn').addEventListener('click', closeModal);
    document.getElementById('modalCancelBtn').addEventListener('click', closeModal);
    document.getElementById('modalForm').addEventListener('submit', e => { e.preventDefault(); const result = editor?.(); if (result !== false) closeModal(); });
    renderAll();
    enhanceSelects();
  }

  // Anchored month picker: opens directly beneath the month field.
  // This avoids full-screen overlays and works reliably on desktop and mobile.
  let monthPickerState = null;
  let monthPickerOutsideHandlerAttached = false;

  function closeMonthPicker() {
    document.querySelectorAll('.month-picker-inline.open').forEach(el => {
      el.classList.remove('open');
      const display = el.querySelector('.month-display');
      if (display) display.setAttribute('aria-expanded', 'false');
    });
    monthPickerState = null;
  }

  function openMonthPicker(id) {
    const input = document.getElementById(id);
    if (!input) return;

    const wrapperId = id === 'dashboardMonth' ? 'dashboardMonthPicker' : 'reportMonthPicker';
    const wrapper = document.getElementById(wrapperId);
    const menu = wrapper?.querySelector('.month-picker-menu');
    const display = wrapper?.querySelector('.month-display');
    if (!wrapper || !menu || !display) return;

    const current = input.value || monthKey(localToday());
    const [currentYear] = current.split('-').map(Number);
    monthPickerState = {
      id,
      year: currentYear || new Date().getFullYear(),
      value: current
    };

    // Close any other month picker first.
    document.querySelectorAll('.month-picker-inline.open').forEach(el => {
      if (el !== wrapper) {
        el.classList.remove('open');
        el.querySelector('.month-display')?.setAttribute('aria-expanded', 'false');
      }
    });

    wrapper.classList.add('open');
    display.setAttribute('aria-expanded', 'true');

    const renderPicker = () => {
      const y = monthPickerState.year;
      const selected = input.value || monthPickerState.value || monthKey(localToday());
      const selectedYear = Number(selected.slice(0, 4));
      const selectedMonth = Number(selected.slice(5, 7));

      menu.innerHTML = `
        <div class="month-picker-title-row">
          <div>
            <span class="eyebrow">SELECT MONTH</span>
            <strong class="month-picker-subtitle">Choose a month</strong>
          </div>
          <button type="button" class="month-picker-close" aria-label="Close month picker">×</button>
        </div>
        <div class="month-picker-head">
          <button type="button" class="month-picker-nav" data-year="-1" aria-label="Previous year">‹</button>
          <strong>${y}</strong>
          <button type="button" class="month-picker-nav" data-year="1" aria-label="Next year">›</button>
        </div>
        <div class="month-picker-grid">
          ${Array.from({length: 12}, (_, i) => {
            const active = y === selectedYear && (i + 1) === selectedMonth;
            const name = new Date(y, i, 1).toLocaleString('en-US', { month: 'short' });
            return `<button type="button" class="month-picker-option${active ? ' selected' : ''}" data-month="${pad(i + 1)}">${name}</button>`;
          }).join('')}
        </div>
        <button type="button" class="month-picker-today" data-today="1">This month</button>`;

      menu.querySelector('.month-picker-close')?.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        closeMonthPicker();
      });

      menu.querySelectorAll('[data-year]').forEach(btn => btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        monthPickerState.year += Number(btn.dataset.year);
        renderPicker();
      }));

      menu.querySelectorAll('[data-month]').forEach(btn => btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        const value = `${monthPickerState.year}-${btn.dataset.month}`;
        setSelectedMonth(id, value);
        closeMonthPicker();
      }));

      menu.querySelector('[data-today]')?.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        setSelectedMonth(id, monthKey(localToday()));
        closeMonthPicker();
      });
    };

    renderPicker();

    if (!monthPickerOutsideHandlerAttached) {
      document.addEventListener('click', e => {
        const active = document.querySelector('.month-picker-inline.open');
        if (active && !active.contains(e.target)) closeMonthPicker();
      }, true);
      monthPickerOutsideHandlerAttached = true;
    }
  }

  function setSelectedMonth(id, value) {
    const input = document.getElementById(id);
    if (!input) return;
    input.value = value;

    // Keep Dashboard and Reports synchronized so the same selected month is
    // always reflected in both places.
    const otherId = id === 'dashboardMonth' ? 'reportMonth' : 'dashboardMonth';
    const other = document.getElementById(otherId);
    if (other) other.value = value;

    state.settings.defaultMonth = value;
    persistOnly();
    renderAll();
  }

  function switchSection(id) {
    document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === id));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.section === id));
    renderAll(); window.scrollTo({top:0, behavior:'smooth'});
  }

  function shiftMonth(inputId, delta) {
    const el = document.getElementById(inputId); const value = el.value || monthKey(localToday()); const [y,m] = value.split('-').map(Number);
    const d = new Date(y, m-1+delta, 1); el.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}`;
    if (inputId === 'dashboardMonth') { state.settings.defaultMonth = el.value; persistOnly(); }
    renderAll();
  }

  function renderAll() { populateFilters(); renderDashboard(); renderBills(); renderCash(); renderReports(); enhanceSelects(); }

  // Replace native dropdowns with compact in-app dropdowns so option menus
  // stay inside the available width on narrow/mobile screens. The hidden
  // native <select> remains the source of truth for existing form logic.
  let customSelectDocumentListenerAttached = false;
  function enhanceSelects(root=document) {
    root.querySelectorAll('select').forEach(select => {
      if (select.dataset.customized === 'true') {
        syncCustomSelect(select);
        return;
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'custom-select';
      wrapper.dataset.forSelect = select.id || '';

      select.parentNode.insertBefore(wrapper, select);
      wrapper.appendChild(select);

      select.dataset.customized = 'true';
      select.classList.add('native-select-hidden');

      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'custom-select-trigger';
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');

      const menu = document.createElement('div');
      menu.className = 'custom-select-menu';
      menu.setAttribute('role', 'listbox');

      wrapper.appendChild(trigger);
      wrapper.appendChild(menu);

      select._customSelect = {wrapper, trigger, menu};

      trigger.addEventListener('click', e => {
        e.preventDefault();
        document.querySelectorAll('.custom-select.open').forEach(other => {
          if (other !== wrapper) closeCustomSelect(other);
        });
        const open = wrapper.classList.toggle('open');
        trigger.setAttribute('aria-expanded', String(open));
      });

      select.addEventListener('change', () => syncCustomSelect(select));
      syncCustomSelect(select);

      menu.addEventListener('click', e => {
        const optionButton = e.target.closest('[data-option-value]');
        if (!optionButton) return;
        const value = optionButton.dataset.optionValue;
        select.value = value;
        select.dispatchEvent(new Event('change', {bubbles:true}));
        closeCustomSelect(wrapper);
      });
    });

    if (!customSelectDocumentListenerAttached) {
      document.addEventListener('click', e => {
        if (!e.target.closest('.custom-select')) {
          document.querySelectorAll('.custom-select.open').forEach(closeCustomSelect);
        }
      });
      customSelectDocumentListenerAttached = true;
    }
  }

  function closeCustomSelect(wrapper) {
    wrapper.classList.remove('open');
    const trigger = wrapper.querySelector('.custom-select-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }

  function syncCustomSelect(select) {
    const ui = select._customSelect;
    if (!ui) return;

    const selected = select.options[select.selectedIndex];
    ui.trigger.textContent = selected ? selected.textContent : '';
    ui.trigger.disabled = select.disabled;

    ui.menu.innerHTML = '';
    Array.from(select.options).forEach(option => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'custom-select-option';
      item.dataset.optionValue = option.value;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.selected));
      item.disabled = option.disabled;
      item.textContent = option.textContent;
      if (option.selected) item.classList.add('selected');
      ui.menu.appendChild(item);
    });
  }
  function populateFilters() {
    const el = document.getElementById('billCategoryFilter'); const selected = el.value || 'all';
    el.innerHTML = '<option value="all">All categories</option>' + CATEGORIES.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join(''); el.value = selected;
  }

  function renderDashboard() {
    const m = document.getElementById('dashboardMonth').value || monthKey(localToday());
    const label = monthLabel(m); document.getElementById('dashboardMonthTitle').textContent = label; document.getElementById('dashboardMonthDisplay').textContent = label;
    const exp = monthlyExpenses(m), outstanding = monthlyUnpaidBills(m), totalMonth = exp + outstanding;
    document.getElementById('statTotalExpenses').textContent = money(exp);
    document.getElementById('statTotalBillsExpenses').textContent = money(totalMonth);
    document.getElementById('statBillsPaid').textContent = money(exp);
    document.getElementById('statBillsPaidCount').textContent = `${paidBills(m).length} paid`;
    document.getElementById('statBillsRemaining').textContent = money(outstanding);
    document.getElementById('statBillsRemainingCount').textContent = `${state.bills.filter(b => b.status !== 'Paid' && isInMonth(b.dueDate,m)).length} unpaid`;
    document.getElementById('statCash').textContent = money(cashInHand());
    document.getElementById('totalAvailable').textContent = money(totalAvailable());
    document.getElementById('bankBalancesList').innerHTML = state.banks.length ? state.banks.map(b => `<div class="bank-row"><div><strong>${esc(b.name)}</strong><span class="sub">Current balance</span></div><div class="amount">${money(bankBalance(b.id))}</div></div>`).join('') : '<div class="empty-state">Add your first bank account.</div>';
    const upcoming = state.bills.filter(b => b.status !== 'Paid').sort((a,b) => String(a.dueDate).localeCompare(String(b.dueDate))).slice(0,5);
    document.getElementById('upcomingBills').innerHTML = upcoming.length ? upcoming.map(b => `<div class="list-row"><div><strong>${esc(b.name)}</strong><span class="sub">${fmtDate(b.dueDate)} • ${esc(b.category)}</span></div><div><div class="amount">${money(b.amount)}</div><span class="badge unpaid">Unpaid</span></div></div>`).join('') : '<div class="empty-state">No unpaid bills.</div>';
    const cats = categoryTotals(m), max = Math.max(...Object.values(cats), 1);
    document.getElementById('categoryBreakdown').innerHTML = Object.entries(cats).filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1]).map(([c,v]) => `<div class="category-row"><div class="category-meta"><strong>${esc(c)}</strong><div class="category-bar"><div class="category-fill" style="width:${(v/max)*100}%"></div></div></div><div class="category-right"><strong>${money(v)}</strong></div></div>`).join('') || '<div class="empty-state">No paid spending recorded for this month.</div>';
    const recent = [...state.bills].sort((a,b) => String(b.paidDate || b.dueDate).localeCompare(String(a.paidDate || a.dueDate))).slice(0,6);
    document.getElementById('recentTransactions').innerHTML = recent.length ? recent.map(b => `<div class="list-row"><div><strong>${esc(b.name)}</strong><span class="sub">${fmtDate(b.paidDate || b.dueDate)} • ${esc(b.category)} • ${esc(b.paymentSource || '—')}</span></div><div><div class="amount">${money(b.amount)}</div><span class="badge ${b.status==='Paid'?'paid':'unpaid'}">${esc(b.status)}</span></div></div>`).join('') : '<div class="empty-state">No bills or expenses yet.</div>';
  }

  function renderBills() {
    const q = document.getElementById('billSearch').value.trim().toLowerCase(), status = document.getElementById('billStatusFilter').value, cat = document.getElementById('billCategoryFilter').value;
    const rows = state.bills.filter(b => {
      const matchesQ = !q || `${b.name} ${b.category} ${b.paymentSource} ${b.notes}`.toLowerCase().includes(q);
      const matchesS = status === 'all' || (status === 'paid' ? b.status === 'Paid' : b.status !== 'Paid');
      const matchesC = cat === 'all' || b.category === cat;
      return matchesQ && matchesS && matchesC;
    }).sort((a,b) => String(a.dueDate).localeCompare(String(b.dueDate)));
    const body = document.getElementById('billsTableBody');
    body.innerHTML = rows.map(b => `<tr>
      <td class="notes-aware"><strong>${esc(b.name)}</strong>${b.notes ? `<span class="table-sub">${esc(b.notes)}</span>` : ''}</td>
      <td>${esc(b.category)}</td>
      <td>${fmtDate(b.dueDate)}</td>
      <td><strong>${money(b.amount)}</strong></td>
      <td><span class="badge ${b.status==='Paid'?'paid':'unpaid'}">${esc(b.status)}</span>${b.status==='Paid'&&b.paidDate ? `<span class="table-sub">Paid ${fmtDate(b.paidDate)}</span>` : ''}</td>
      <td>${esc(b.paymentSource || '—')}</td>
      <td class="action-cell">${b.status!=='Paid' ? `<button class="mini-btn success-action" type="button" data-action="paid" data-id="${esc(b.id)}">✓ Mark Paid</button>` : ''}<button class="mini-btn" type="button" data-action="editBill" data-id="${esc(b.id)}">Edit</button><button class="mini-btn danger" type="button" data-action="deleteBill" data-id="${esc(b.id)}">Delete</button></td>
    </tr>`).join('');
    document.getElementById('billsEmpty').classList.toggle('hidden', rows.length > 0);
    body.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', () => handleBillAction(btn.dataset.action, btn.dataset.id)));
  }

  function handleBillAction(action,id) {
    const b = state.bills.find(x => x.id === id); if (!b) return;
    if (action === 'paid') { b.status='Paid'; b.paidDate=localToday(); save(); toast('Bill marked as paid.'); return; }
    if (action === 'editBill') openBillModal(id);
    if (action === 'deleteBill') confirmDeleteBill(id);
  }

  function renderCash() {
    document.getElementById('totalBankBalance').textContent = money(totalBankBalance());
    document.getElementById('cashInHand').textContent = money(cashInHand());
    document.getElementById('cashTotalAvailable').textContent = money(totalAvailable());

    document.getElementById('bankCards').innerHTML = state.banks.length ? state.banks.map(b => `<div class="bank-card"><div class="bank-card-head"><div><div class="bank-name">${esc(b.name)}</div><div class="bank-id">Starting balance ${money(b.startingBalance)}</div></div><button class="icon-mini" type="button" data-bank-edit="${esc(b.id)}" aria-label="Edit bank">✎</button></div><div class="bank-balance">${money(bankBalance(b.id))}</div><div class="bank-actions"><button class="mini-btn" type="button" data-bank-edit="${esc(b.id)}">Edit</button><button class="mini-btn danger" type="button" data-bank-delete="${esc(b.id)}">Delete</button></div></div>`).join('') : '<div class="empty-state">No bank accounts yet. Add a bank to begin tracking balances.</div>';
    document.querySelectorAll('[data-bank-edit]').forEach(btn => btn.addEventListener('click', () => openBankModal(btn.dataset.bankEdit)));
    document.querySelectorAll('[data-bank-delete]').forEach(btn => btn.addEventListener('click', () => confirmDeleteBank(btn.dataset.bankDelete)));

    const alloc = cashAllocationMap().allocations;
    const wRows = [...state.withdrawals].sort((a,b) => String(b.date).localeCompare(String(a.date)));
    document.getElementById('withdrawalsTableBody').innerHTML = wRows.map(w => {
      const bank = state.banks.find(b => b.id === w.bankId);
      const used = alloc[w.id] || 0;
      const remaining = Math.max(0, (Number(w.amount)||0) - used);
      return `<tr><td>${fmtDate(w.date)}</td><td>${esc(bank?.name || '—')}</td><td><strong>${money(w.amount)}</strong></td><td>${money(used)}</td><td><strong>${money(remaining)}</strong></td><td>${esc(w.notes || '')}</td><td><button class="mini-btn danger" type="button" data-withdrawal-delete="${esc(w.id)}">Delete</button></td></tr>`;
    }).join('');
    document.getElementById('withdrawalsEmpty').classList.toggle('hidden', wRows.length > 0);
    document.querySelectorAll('[data-withdrawal-delete]').forEach(btn => btn.addEventListener('click', () => confirmDeleteWithdrawal(btn.dataset.withdrawalDelete)));

    const tRows = [...state.bankTransactions].sort((a,b) => String(b.date).localeCompare(String(a.date)));
    document.getElementById('bankTransactionsTableBody').innerHTML = tRows.map(t => {
      const typeLabel = t.type==='transfer' ? 'Transfer' : (t.type==='deposit' ? 'Deposit' : 'Withdrawal');
      const badgeClass = t.type==='deposit' ? 'paid' : (t.type==='transfer' ? 'transfer-badge' : 'unpaid');
      let bankCell='—';
      if(t.type==='transfer'){
        const from=state.banks.find(b=>b.id===t.fromBankId)?.name || '—';
        const to=state.banks.find(b=>b.id===t.toBankId)?.name || '—';
        bankCell=`${esc(from)} <span class="transfer-arrow">→</span> ${esc(to)}`;
      } else { bankCell=esc(state.banks.find(b => b.id === t.bankId)?.name || '—'); }
      return `<tr><td>${fmtDate(t.date)}</td><td>${bankCell}</td><td><span class="badge ${badgeClass}">${typeLabel}</span></td><td><strong>${money(t.amount)}</strong></td><td class="notes-cell">${esc(t.notes || '')}</td><td><button class="mini-btn danger" type="button" data-tx-delete="${esc(t.id)}">Delete</button></td></tr>`;
    }).join('');
    document.getElementById('bankTransactionsEmpty').classList.toggle('hidden', tRows.length > 0);
    document.querySelectorAll('[data-tx-delete]').forEach(btn => btn.addEventListener('click', () => confirmDeleteTransaction(btn.dataset.txDelete)));
  }

  function renderReports() {
    const m = document.getElementById('reportMonth').value || monthKey(localToday());
    document.getElementById('reportMonthDisplay').textContent = monthLabel(m);
    const paidTotal = monthlyExpenses(m), unpaidTotal = monthlyUnpaidBills(m);
    document.getElementById('reportTotal').textContent = money(paidTotal);
    document.getElementById('reportGrandTotal').textContent = money(paidTotal + unpaidTotal);
    document.getElementById('reportPaid').textContent = money(monthlyExpenses(m));
    document.getElementById('reportOutstanding').textContent = money(monthlyUnpaidBills(m));
    document.getElementById('reportMonthLabel').textContent = monthLabel(m);
    const cats = categoryTotals(m), max = Math.max(...Object.values(cats), 1);
    document.getElementById('reportCategories').innerHTML = Object.entries(cats).filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1]).map(([c,v]) => `<div class="category-row"><div class="category-meta"><strong>${esc(c)}</strong><div class="category-bar"><div class="category-fill" style="width:${(v/max)*100}%"></div></div></div><div class="category-right"><strong>${money(v)}</strong></div></div>`).join('') || '<div class="empty-state">No paid bills or expenses for this month.</div>';
    const months = new Set(state.bills.flatMap(b => [monthKey(b.dueDate), monthKey(b.paidDate)]).filter(Boolean)); months.add(m);
    const monthList = [...months].sort().reverse().slice(0,8);
    document.getElementById('monthlyHistory').innerHTML = monthList.map(key => `<div class="history-row ${key===m?'current':''}"><div><strong>${esc(monthLabel(key))}</strong><span class="sub">${paidBills(key).length} paid • ${state.bills.filter(b => b.status!=='Paid'&&isInMonth(b.dueDate,key)).length} unpaid</span></div><div class="amount">${money(monthlyExpenses(key))}</div></div>`).join('');
  }

  function openModal(title, eyebrow, body, onSave) {
    editor = onSave;
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalEyebrow').textContent = eyebrow;
    document.getElementById('modalBody').innerHTML = body;
    enhanceSelects(document.getElementById('modalBody'));
    const dlg = document.getElementById('modal');
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open','');
  }
  function closeModal() { editor=null; const dlg=document.getElementById('modal'); if (typeof dlg.close === 'function' && dlg.open) dlg.close(); else dlg.removeAttribute('open'); document.getElementById('modalBody').innerHTML=''; }
  function field(name,label,html,full=false,help='') { return `<div class="field ${full?'full':''}"><label for="${name}">${label}</label>${html}${help?`<div class="field-help">${help}</div>`:''}</div>`; }
  function options(values,selected='') { return values.map(v => `<option value="${esc(v)}" ${String(v)===String(selected)?'selected':''}>${esc(v)}</option>`).join(''); }

  function openBillModal(id='') {
    const b = id ? state.bills.find(x => x.id === id) : null;
    openModal(id ? 'Edit Bill / Expense' : 'Add Bill / Expense', 'BILL / EXPENSE', `<div class="form-grid">
      ${field('mBillName','Bill / Expense Name',`<input id="mBillName" required placeholder="e.g. Internet, Food, Electricity" value="${esc(b?.name || '')}">`,true)}
      ${field('mBillCategory','Category',`<select id="mBillCategory">${options(CATEGORIES,b?.category || CATEGORIES[0])}</select>`)}
      ${field('mBillAmount','Amount',`<input id="mBillAmount" type="number" min="0.01" step="0.01" required placeholder="0.00" value="${b?.amount ?? ''}">`)}
      ${field('mBillDue','Due / Transaction Date',`<input id="mBillDue" type="date" required value="${esc(b?.dueDate || localToday())}">`)}
      ${field('mBillStatus','Status',`<select id="mBillStatus"><option value="Unpaid" ${(b?.status || 'Unpaid') === 'Unpaid' ? 'selected' : ''}>Unpaid</option><option value="Paid" ${(b?.status || 'Unpaid') === 'Paid' ? 'selected' : ''}>Paid</option></select>`)}
      ${field('mBillSource','Payment Source (optional)',`<select id="mBillSource"><option value="" ${(b?.paymentSource || '') === '' ? 'selected' : ''}>Select source</option><option value="Cash" ${b?.paymentSource === 'Cash' ? 'selected' : ''}>Cash</option><option value="GCash" ${b?.paymentSource === 'GCash' ? 'selected' : ''}>GCash</option></select>`,true,'Choose Cash when the payment came from your physical cash balance. Choose GCash for GCash payments.')}
      ${field('mBillNotes','Notes (Optional)',`<textarea id="mBillNotes" rows="3" placeholder="Add a short note if useful">${esc(b?.notes || '')}</textarea>`,true)}
    </div>`, () => {
      const data = {id:b?.id || uid('bill'), name:document.getElementById('mBillName').value.trim(), category:document.getElementById('mBillCategory').value,
        amount:Number(document.getElementById('mBillAmount').value), dueDate:document.getElementById('mBillDue').value,
        status:document.getElementById('mBillStatus').value, paymentSource:document.getElementById('mBillSource').value.trim(),
        notes:document.getElementById('mBillNotes').value.trim(), paidDate:b?.paidDate || ''};
      if(!data.name || !data.dueDate || !Number.isFinite(data.amount) || data.amount <= 0) { showFormError('Please enter the bill/expense name, date, and a valid amount.'); return false; }
      if(data.status === 'Paid' && !data.paidDate) data.paidDate=data.dueDate;
      if(data.status === 'Unpaid') data.paidDate='';
      if(b) Object.assign(b,data); else state.bills.push(data);
      save(); toast('Bill / expense saved.');
    });
  }

  function openBankModal(id='') {
    const b = id ? state.banks.find(x => x.id === id) : null;
    openModal(id ? 'Edit Bank' : 'Add Bank', 'BANK ACCOUNT', `<div class="form-grid">${field('mBankName','Bank Name',`<input id="mBankName" required placeholder="e.g. BDO" value="${esc(b?.name || '')}">`)}${field('mBankStart','Starting Balance',`<input id="mBankStart" type="number" min="0" step="0.01" required value="${b?.startingBalance ?? 0}">`)}${field('mBankNotes','Notes',`<textarea id="mBankNotes" rows="3" placeholder="Optional note">${esc(b?.notes || '')}</textarea>`,true)}</div>`, () => {
      const data={id:b?.id || uid('bank'),name:document.getElementById('mBankName').value.trim(),startingBalance:Number(document.getElementById('mBankStart').value),notes:document.getElementById('mBankNotes').value.trim()};
      if(!data.name || !Number.isFinite(data.startingBalance) || data.startingBalance < 0){showFormError('Please enter a valid bank name and starting balance.');return false;}
      if(b) Object.assign(b,data); else state.banks.push(data); save(); toast('Bank saved.');
    });
  }

  function openBankTransactionModal() {
    if(!state.banks.length){alert('Add a bank account first.');return;}
    openModal('Bank Transaction','BANK ACTIVITY',`<div class="form-grid">${field('mTxBank','Bank',`<select id="mTxBank">${state.banks.map(b=>`<option value="${esc(b.id)}">${esc(b.name)} • ${money(bankBalance(b.id))} current</option>`).join('')}</select>`)}${field('mTxType','Type',`<select id="mTxType"><option value="deposit">Deposit</option><option value="withdrawal">Withdrawal</option></select>`,false,'A simple deposit or withdrawal that changes the selected bank balance. For moving money between two banks, use Fast Transfer.')}
      ${field('mTxAmount','Amount',`<input id="mTxAmount" type="number" min="0.01" step="0.01" required placeholder="0.00">`)}${field('mTxDate','Date',`<input id="mTxDate" type="date" required value="${localToday()}">`)}${field('mTxNotes','Notes',`<textarea id="mTxNotes" rows="3" placeholder="e.g. Salary, bank fee, adjustment"></textarea>`,true)}</div>`, () => {
      const data={id:uid('tx'),bankId:document.getElementById('mTxBank').value,type:document.getElementById('mTxType').value,amount:Number(document.getElementById('mTxAmount').value),date:document.getElementById('mTxDate').value,notes:document.getElementById('mTxNotes').value.trim()};
      if(!Number.isFinite(data.amount) || data.amount <= 0 || !data.date){showFormError('Enter a valid amount and date.');return false;}
      state.bankTransactions.push(data); save(); toast('Bank transaction saved.');
    });
  }

  function openTransferModal() {
    if(state.banks.length < 2){alert('Add at least two bank accounts to use Fast Transfer.');return;}
    const bankOptions=(selected='')=>state.banks.map(b=>`<option value="${esc(b.id)}" ${b.id===selected?'selected':''}>${esc(b.name)} • ${money(bankBalance(b.id))} current</option>`).join('');
    const first=state.banks[0]?.id || '', second=state.banks[1]?.id || '';
    openModal('Fast Bank Transfer','MOVE MONEY BETWEEN BANKS',`<div class="transfer-help">Move money from one bank directly to another. The source bank goes down and the destination bank goes up automatically.</div><div class="form-grid">
      ${field('mTrFrom','From Bank',`<select id="mTrFrom">${bankOptions(first)}</select>`)}
      ${field('mTrTo','To Bank',`<select id="mTrTo">${bankOptions(second)}</select>`)}
      ${field('mTrAmount','Amount',`<input id="mTrAmount" type="number" min="0.01" step="0.01" required placeholder="0.00">`)}
      ${field('mTrDate','Date',`<input id="mTrDate" type="date" required value="${localToday()}">`)}
      ${field('mTrNotes','Notes',`<textarea id="mTrNotes" rows="3" placeholder="e.g. Transfer to savings"></textarea>`,true)}
    </div>`, () => {
      const fromBankId=document.getElementById('mTrFrom').value, toBankId=document.getElementById('mTrTo').value;
      const amount=Number(document.getElementById('mTrAmount').value), date=document.getElementById('mTrDate').value;
      if(fromBankId===toBankId){showFormError('Choose two different banks.');return false;}
      if(!Number.isFinite(amount) || amount <= 0 || !date){showFormError('Enter a valid transfer amount and date.');return false;}
      const sourceBalance=bankBalance(fromBankId);
      if(amount>sourceBalance && !confirm(`This transfer is greater than the tracked source balance (${money(sourceBalance)}). Continue anyway?`)) return false;
      state.bankTransactions.push({id:uid('tx'),type:'transfer',fromBankId,toBankId,amount,date,notes:document.getElementById('mTrNotes').value.trim()});
      save(); toast('Transfer saved — both bank balances updated.');
    });
  }

  function openWithdrawalModal() {
    if(!state.banks.length){alert('Add a bank account first.');return;}
    openModal('Cash Withdrawal','CASH WITHDRAWAL',`<div class="form-grid">${field('mWBank','Bank',`<select id="mWBank">${state.banks.map(b=>`<option value="${esc(b.id)}">${esc(b.name)} • ${money(bankBalance(b.id))} current</option>`).join('')}</select>`)}${field('mWAmount','Money Withdrawn',`<input id="mWAmount" type="number" min="0.01" step="0.01" required placeholder="0.00">`)}${field('mWDate','Date',`<input id="mWDate" type="date" required value="${localToday()}">`)}${field('mWNotes','Notes',`<textarea id="mWNotes" rows="3" placeholder="ATM, purpose, etc."></textarea>`,true,'This creates a cash balance. When a paid bill / expense uses Payment Source containing “Cash”, the cash amount is automatically deducted using oldest-withdrawal-first.')}</div>`, () => {
      const bankId=document.getElementById('mWBank').value, amount=Number(document.getElementById('mWAmount').value), date=document.getElementById('mWDate').value;
      if(!Number.isFinite(amount) || amount <= 0 || !date){showFormError('Enter a valid withdrawal amount and date.');return false;}
      const balance=bankBalance(bankId); if(amount>balance && !confirm(`This withdrawal is greater than the tracked bank balance (${money(balance)}). Continue anyway?`)) return false;
      state.withdrawals.push({id:uid('wd'),bankId,amount,date,notes:document.getElementById('mWNotes').value.trim()}); save(); toast('Cash withdrawal saved.');
    });
  }

  function showFormError(msg){ toast(msg); const form=document.getElementById('modalForm'); form.animate([{transform:'translateX(0)'},{transform:'translateX(-5px)'},{transform:'translateX(5px)'},{transform:'translateX(0)'}],{duration:180}); }
  function confirmDeleteBill(id){ if(!confirm('Delete this bill / expense?')) return; state.bills=state.bills.filter(x=>x.id!==id); save(); toast('Deleted.'); }
  function confirmDeleteBank(id){ const hasTx=state.withdrawals.some(x=>x.bankId===id)||state.bankTransactions.some(x=>x.bankId===id); if(hasTx){alert('This bank has transactions or cash withdrawals. Delete those first.');return;} if(!confirm('Delete this bank account?'))return; state.banks=state.banks.filter(x=>x.id!==id); save(); toast('Bank deleted.'); }
  function confirmDeleteWithdrawal(id){ if(!confirm('Delete this cash withdrawal? Its cash amount will also be removed from Cash in Hand.'))return; state.withdrawals=state.withdrawals.filter(x=>x.id!==id); save(); toast('Cash withdrawal deleted.'); }
  function confirmDeleteTransaction(id){ if(!confirm('Delete this bank transaction?'))return; state.bankTransactions=state.bankTransactions.filter(x=>x.id!==id); save(); toast('Bank transaction deleted.'); }

  function downloadBlob(content,filename,type){ const blob=new Blob([content],{type}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),500); }
  function exportBackup(){ downloadBlob(JSON.stringify({...state,exportedAt:new Date().toISOString()},null,2),`bill-tracker-backup-${localToday()}.json`,'application/json'); toast('Backup exported.'); }
  function csvCell(value){ const s=String(value ?? ''); return `"${s.replace(/"/g,'""')}"`; }

  // ------------------------------------------------------------
  // Offline Excel / CSV export
  // ------------------------------------------------------------
  // The Excel export is self-contained and does not depend on a
  // CDN or internet connection. It creates a real .xlsx workbook
  // with 3 worksheets directly in the browser.

  function xmlEscape(value){
    return String(value ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&apos;');
  }

  function excelColName(number){
    let n=number, out='';
    while(n>0){
      const rem=(n-1)%26;
      out=String.fromCharCode(65+rem)+out;
      n=Math.floor((n-1)/26);
    }
    return out;
  }

  function cellXml(rowIndex, colIndex, value, styleIndex){
    if(value===null || value===undefined || value==='') return '';
    const ref=`${excelColName(colIndex)}${rowIndex}`;
    const style=styleIndex ? ` s="${styleIndex}"` : '';

    if(typeof value==='number' && Number.isFinite(value)){
      return `<c r="${ref}"${style} t="n"><v>${value}</v></c>`;
    }

    return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  }

  function worksheetXml(rows, widths){
    let dimensionMaxCol=1;
    rows.forEach(r=>{ dimensionMaxCol=Math.max(dimensionMaxCol,r.length); });
    const dimensionMaxRow=Math.max(1,rows.length);

    let xml=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`+
      `<dimension ref="A1:${excelColName(dimensionMaxCol)}${dimensionMaxRow}"/>`+
      `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;

    if(widths && widths.length){
      xml+='<cols>';
      widths.forEach((w,i)=>{
        const width=Number(w)||16;
        xml+=`<col min="${i+1}" max="${i+1}" width="${Math.min(Math.max(width,8),90)}" customWidth="1"/>`;
      });
      xml+='</cols>';
    }

    xml+='<sheetData>';
    rows.forEach((row,rowIndex)=>{
      const r=rowIndex+1;
      xml+=`<row r="${r}">`;
      row.forEach((value,colIndex)=>{
        let style=0;
        if(rowIndex===0) style=1; // report title
        else if(rowIndex>0 && Array.isArray(row) && rowIndex < rows.length &&
                ((row[0]==='ID' && rowIndex>0) ||
                 (typeof row[0]==='string' && /^(ID|Date|Month|Name \/ Description|Category|Amount \(PHP\)|Status|Paid Date|Payment Source|Notes|Bank|Opening Balance \(PHP\)|Current Balance \(PHP\)|Type|Bank \/ Source|Destination|Cash Used \(PHP\)|Cash Remaining \(PHP\)|Money Withdrawn \(PHP\)|Setting|Value)$/.test(String(value||'')) && rowIndex<5))){
          style=2;
        }
        xml+=cellXml(r,colIndex+1,value,style);
      });
      xml+='</row>';
    });
    xml+='</sheetData><pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/></worksheet>';
    return xml;
  }

  function crc32(bytes){
    let table=crc32.table;
    if(!table){
      table=new Uint32Array(256);
      for(let n=0;n<256;n++){
        let c=n;
        for(let k=0;k<8;k++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);
        table[n]=c>>>0;
      }
      crc32.table=table;
    }
    let crc=0xFFFFFFFF;
    for(let i=0;i<bytes.length;i++) crc=table[(crc^bytes[i])&0xFF]^(crc>>>8);
    return (crc^0xFFFFFFFF)>>>0;
  }

  function u16(n){ return new Uint8Array([n&255,(n>>>8)&255]); }
  function u32(n){ return new Uint8Array([n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255]); }

  function concatBytes(parts){
    const total=parts.reduce((s,p)=>s+p.length,0);
    const out=new Uint8Array(total);
    let offset=0;
    parts.forEach(p=>{ out.set(p,offset); offset+=p.length; });
    return out;
  }

  function zipStore(files){
    const encoder=new TextEncoder();
    const localParts=[];
    const centralParts=[];
    let offset=0;
    const now=new Date();
    const dosTime=(now.getHours()<<11)|(now.getMinutes()<<5)|Math.floor(now.getSeconds()/2);
    const dosDate=((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();

    files.forEach(file=>{
      const nameBytes=encoder.encode(file.name);
      const data=file.data instanceof Uint8Array ? file.data : encoder.encode(file.data);
      const crc=crc32(data);

      const local=concatBytes([
        u32(0x04034b50),u16(20),u16(0),u16(0),u16(dosTime),u16(dosDate),u32(crc),u32(data.length),u32(data.length),u16(nameBytes.length),u16(0),nameBytes,data
      ]);
      localParts.push(local);

      const central=concatBytes([
        u32(0x02014b50),u16(20),u16(20),u16(0),u16(0),u16(dosTime),u16(dosDate),u32(crc),u32(data.length),u32(data.length),u16(nameBytes.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),nameBytes
      ]);
      centralParts.push(central);
      offset+=local.length;
    });

    const central=concatBytes(centralParts);
    const local=concatBytes(localParts);
    const end=concatBytes([
      u32(0x06054b50),u16(0),u16(0),u16(files.length),u16(files.length),u32(central.length),u32(local.length),u16(0)
    ]);

    return concatBytes([local,central,end]);
  }

  function stylesXml(){
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="0"/>
  <fonts count="3">
    <font><sz val="11"/><name val="Aptos"/></font>
    <font><b/><sz val="16"/><name val="Aptos Display"/></font>
    <font><b/><sz val="11"/><name val="Aptos"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="E8F3EE"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="D9E3DD"/></left><right style="thin"><color rgb="D9E3DD"/></right><top style="thin"><color rgb="D9E3DD"/></top><bottom style="thin"><color rgb="D9E3DD"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="2" fillId="1" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  }

  function buildReportSheets(){
    const dashboardMonth = document.getElementById('dashboardMonth')?.value || monthKey(localToday());
    const dashLabel = monthLabel(dashboardMonth);

    // ---------- Dashboard & Reports ----------
    const monthBills = state.bills.filter(b => isInMonth(b.dueDate, dashboardMonth));
    const monthPaid = monthBills.filter(b => b.status === 'Paid');
    const monthUnpaid = monthBills.filter(b => b.status !== 'Paid');
    const monthPaidTotal = monthPaid.reduce((sum,b)=>sum+(Number(b.amount)||0),0);
    const monthUnpaidTotal = monthUnpaid.reduce((sum,b)=>sum+(Number(b.amount)||0),0);
    const monthAllTotal = monthPaidTotal + monthUnpaidTotal;

    const dashboardRows = [
      ['PERSONAL BILL TRACKER — EXCEL REPORT'],
      ['Generated On', fmtDateLong(localToday())],
      [],
      ['HOW TO READ THIS FILE'],
      ['Dashboard & Reports', 'Brief overview of your selected month, money available, and month-by-month spending.'],
      ['Bills & Expenses', 'Complete list of every bill / expense entered, including status, payment source, and notes.'],
      ['Bank & Cash', 'Complete record of bank accounts, bank transactions / transfers, physical cash withdrawals, cash used, and cash remaining.'],
      ['Transparency', 'The detailed Bills & Expenses and Bank & Cash sheets are the full records used to understand the summary.'],
      [],
      ['SELECTED MONTH SUMMARY', dashLabel],
      ['Monthly Expenses (Paid)', monthPaidTotal],
      ['Total Bills & Expenses (Paid + Unpaid)', monthAllTotal],
      ['Bills Paid', monthPaid.length],
      ['Bills Remaining', monthUnpaid.length],
      ['Unpaid Amount', monthUnpaidTotal],
      ['Total Bank Balance', totalBankBalance()],
      ['Cash in Hand', cashInHand()],
      ['Total Available', totalAvailable()],
      [],
      ['IMPORTANT TERMS'],
      ['Paid', 'The bill or expense has been marked Paid.'],
      ['Unpaid', 'The bill or expense has not been marked Paid yet.'],
      ['Payment Source', 'Cash or GCash.'],
      ['Fast Transfer', 'Money moved from one bank to another. It changes bank balances but is not a spending expense.'],
      ['Cash Withdrawal', 'Physical cash taken from a bank. Bank balance goes down and Cash in Hand goes up.'],
      ['Cash Used', 'Paid bills or expenses whose Payment Source is Cash.'],
      ['Cash Remaining', 'Physical cash from withdrawals that has not yet been used.'],
      ['Total Available', 'Current bank balances plus Cash in Hand.'],
      [],
      ['MONTHLY REPORT'],
      ['Month','Paid Bills / Expenses (PHP)','Unpaid Bills (PHP)','Total Bills / Expenses (PHP)','Cash Withdrawn (PHP)','Cash Used (PHP)']
    ];

    const alloc = cashAllocationMap().allocations;
    const monthKeys = [...new Set([
      ...state.bills.map(b=>monthKey(b.dueDate)),
      ...state.withdrawals.map(w=>monthKey(w.date)),
      ...state.bankTransactions.map(t=>monthKey(t.date))
    ].filter(Boolean))].sort();

    monthKeys.forEach(m=>{
      const bills = state.bills.filter(b=>isInMonth(b.dueDate,m));
      const paid = bills.filter(b=>b.status==='Paid').reduce((s,b)=>s+(Number(b.amount)||0),0);
      const unpaid = bills.filter(b=>b.status!=='Paid').reduce((s,b)=>s+(Number(b.amount)||0),0);
      const withdrawals = state.withdrawals.filter(w=>monthKey(w.date)===m);
      const withdrawn = withdrawals.reduce((s,w)=>s+(Number(w.amount)||0),0);
      const used = withdrawals.reduce((s,w)=>s+(alloc[w.id]||0),0);
      dashboardRows.push([monthLabel(m), paid, unpaid, paid+unpaid, withdrawn, used]);
    });

    dashboardRows.push([]);
    dashboardRows.push(['REPORT NOTE','This workbook is an export of the Bill Tracker data stored in this browser. Keep a JSON backup for restoring the app data.']);

    // ---------- Bills & Expenses ----------
    const billRows = [
      ['BILLS & EXPENSES — COMPLETE RECORD'],
      ['This sheet contains every bill / expense entered for transparency, including all notes.'],
      [],
      ['ID','Date','Month','Name / Description','Category','Amount (PHP)','Status','Paid Date','Payment Source','Notes']
    ];

    [...state.bills]
      .sort((a,b)=>String(a.dueDate).localeCompare(String(b.dueDate)))
      .forEach(b=>billRows.push([
        b.id,
        fmtDateLong(b.dueDate),
        monthLabel(monthKey(b.dueDate)),
        b.name,
        b.category,
        Number(b.amount)||0,
        b.status,
        b.paidDate ? fmtDateLong(b.paidDate) : '',
        b.paymentSource || '',
        b.notes || ''
      ]));

    // ---------- Bank & Cash ----------
    const bankRows = [
      ['BANK & CASH — COMPLETE RECORD'],
      ['This sheet contains bank balances, bank transactions / transfers, and all physical cash withdrawals.'],
      [],
      ['BANK ACCOUNTS'],
      ['ID','Bank','Opening Balance (PHP)','Current Balance (PHP)']
    ];

    [...state.banks].forEach(b=>bankRows.push([
      b.id,
      b.name,
      Number(b.startingBalance)||0,
      bankBalance(b.id)
    ]));

    bankRows.push([]);
    bankRows.push(['BANK TRANSACTIONS & TRANSFERS']);
    bankRows.push(['ID','Date','Month','Type','Bank / Source','Destination','Amount (PHP)','Notes']);

    [...state.bankTransactions]
      .sort((a,b)=>String(a.date).localeCompare(String(b.date)))
      .forEach(t=>{
        const from = state.banks.find(b=>b.id===t.fromBankId)?.name || '';
        const to = state.banks.find(b=>b.id===t.toBankId)?.name || '';
        const bank = state.banks.find(b=>b.id===t.bankId)?.name || '';
        bankRows.push([
          t.id,
          fmtDateLong(t.date),
          monthLabel(monthKey(t.date)),
          t.type === 'deposit' ? 'Deposit' : t.type === 'transfer' ? 'Fast Transfer' : 'Withdrawal',
          t.type === 'transfer' ? from : bank,
          t.type === 'transfer' ? to : '',
          Number(t.amount)||0,
          t.notes || ''
        ]);
      });

    bankRows.push([]);
    bankRows.push(['PHYSICAL CASH / CASH WITHDRAWALS']);
    bankRows.push(['ID','Date','Month','Bank','Money Withdrawn (PHP)','Cash Used (PHP)','Cash Remaining (PHP)','Notes']);

    [...state.withdrawals]
      .sort((a,b)=>String(a.date).localeCompare(String(b.date)))
      .forEach(w=>{
        const used = alloc[w.id] || 0;
        const remaining = Math.max(0,(Number(w.amount)||0)-used);
        bankRows.push([
          w.id,
          fmtDateLong(w.date),
          monthLabel(monthKey(w.date)),
          state.banks.find(b=>b.id===w.bankId)?.name || '',
          Number(w.amount)||0,
          used,
          remaining,
          w.notes || ''
        ]);
      });

    bankRows.push([]);
    const reportCashWithdrawnTotal = state.withdrawals.reduce((sum, w) => sum + (Number(w.amount) || 0), 0);
    const reportCashUsedTotal = state.bills.filter(b => b.status === 'Paid' && isCashSource(b.paymentSource)).reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
    const reportCashInHand = reportCashWithdrawnTotal - reportCashUsedTotal + state.cashAdjustments.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
    bankRows.push(['CASH SUMMARY','Total Withdrawn',reportCashWithdrawnTotal,'Total Used',reportCashUsedTotal,'Cash in Hand',reportCashInHand]);

    return [
      {name:'Dashboard & Reports', rows:dashboardRows, widths:[30,34,24,28,24,18]},
      {name:'Bills & Expenses', rows:billRows, widths:[22,15,18,30,20,16,12,15,18,45]},
      {name:'Bank & Cash', rows:bankRows, widths:[24,15,18,24,24,24,24,45]}
    ];
  }

  function buildExcelBinary(){
    const sheets=buildReportSheets();

    const workbookSheets=sheets.map((sheet,i)=>(
      `<sheet name="${xmlEscape(sheet.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`
    )).join('');

    const workbook=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <fileVersion appName="Microsoft Excel"/>
  <workbookPr defaultThemeVersion="164011"/>
  <bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews>
  <sheets>${workbookSheets}</sheets>
</workbook>`;

    const workbookRels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((s,i)=>`  <Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('\n')}
  <Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

    const rootRels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

    const contentTypes=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((s,i)=>`  <Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`;

    const files=[
      {name:'[Content_Types].xml',data:contentTypes},
      {name:'_rels/.rels',data:rootRels},
      {name:'xl/workbook.xml',data:workbook},
      {name:'xl/_rels/workbook.xml.rels',data:workbookRels},
      {name:'xl/styles.xml',data:stylesXml()}
    ];

    sheets.forEach((sheet,i)=>files.push({
      name:`xl/worksheets/sheet${i+1}.xml`,
      data:worksheetXml(sheet.rows,sheet.widths)
    }));

    return zipStore(files);
  }

  function exportExcelReport(){
    try{
      const bytes=buildExcelBinary();
      const blob=new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;
      a.download=`bill-tracker-report-${localToday()}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
      toast('Excel report exported with 3 sheets.');
    }catch(error){
      console.error(error);
      alert('Excel export failed: ' + (error?.message || error));
    }
  }

  function exportCsv(){
    try{
      const sheets=buildReportSheets();
      const rows=[];
      sheets.forEach((sheet,index)=>{
        if(index) rows.push([]);
        rows.push([sheet.name.toUpperCase()]);
        sheet.rows.forEach(r=>rows.push(r));
      });
      const csv='\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n');
      downloadBlob(csv,`bill-tracker-report-${localToday()}.csv`,'text/csv;charset=utf-8');
      toast('CSV report exported.');
    }catch(error){
      console.error(error);
      alert('CSV export failed: ' + (error?.message || error));
    }
  }

  function importBackup(e){
    const input = e.target;
    const file = input.files?.[0];
    if(!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || ''));
        // Support both the current backup format and a backup wrapped in
        // { state: ... } or { data: ... } for forward compatibility.
        const source = parsed && typeof parsed === 'object'
          ? (parsed.state && typeof parsed.state === 'object' ? parsed.state :
             (parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed))
          : null;

        if(!source || typeof source !== 'object') {
          throw new Error('Invalid backup structure.');
        }

        const incoming = normalize(source);
        const hasKnownData = ['bills','banks','bankTransactions','withdrawals'].some(
          key => Array.isArray(incoming[key])
        );

        if(!hasKnownData) {
          throw new Error('This file does not appear to be a Bill Tracker backup.');
        }

        const billCount = incoming.bills.length;
        const bankCount = incoming.banks.length;
        const txCount = incoming.bankTransactions.length;
        const wdCount = incoming.withdrawals.length;

        const confirmed = confirm(
          `Import this backup and replace the current data?\n\n` +
          `Bills / expenses: ${billCount}\n` +
          `Bank accounts: ${bankCount}\n` +
          `Bank transactions: ${txCount}\n` +
          `Cash withdrawals: ${wdCount}`
        );

        if(!confirmed) {
          toast('Import cancelled. Your current data was not changed.');
          return;
        }

        state = incoming;
        state.settings.defaultMonth = state.settings.defaultMonth || monthKey(localToday());

        const dashboardMonth = document.getElementById('dashboardMonth');
        const reportMonth = document.getElementById('reportMonth');
        if(dashboardMonth) dashboardMonth.value = state.settings.defaultMonth;
        if(reportMonth) reportMonth.value = state.settings.defaultMonth;

        // Persist without triggering nested UI work, then render once.
        persistOnly();
        renderAll();

        toast(`Backup imported successfully — ${billCount} bills/expenses restored.`);
      } catch(error) {
        console.error('Import failed:', error);
        alert('Import failed: ' + (error?.message || 'The backup file is invalid.'));
      } finally {
        // Reset the file input so the same backup can be selected again.
        input.value = '';
      }
    };

    reader.onerror = () => {
      input.value = '';
      alert('Import failed: the backup file could not be read.');
    };

    reader.readAsText(file);
  }

  function clearAllData(){
    const first = confirm(
      'Clear ALL Bill Tracker data from this browser?\n\n' +
      'This will remove bills, bank accounts, transactions, transfers, cash withdrawals, and cash adjustments.\n\n' +
      'Your exported backup files will not be deleted.'
    );

    if(!first) return;

    const second = confirm(
      'Are you sure? This cannot be undone unless you have a backup file.'
    );

    if(!second) return;

    state = defaultState();
    persistOnly();
    renderAll();
    toast('All local data has been cleared.');
  }
  function toast(msg){ const el=document.getElementById('toast'); el.textContent=msg; el.classList.add('show'); clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.remove('show'),2800); }

  init();
})();

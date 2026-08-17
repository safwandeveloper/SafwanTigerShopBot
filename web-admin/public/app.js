const state = { data: null, config: null, section: 'overview', page: 0, rows: [], total: 0, search: '', editing: null };
const $ = (selector) => document.querySelector(selector);
const money = (value) => `$${Number(value ?? 0).toFixed(2)}`;
const date = (value) => value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));

async function request(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) throw new Error('unauthorized');
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error ?? 'Request failed');
  return body;
}

function table(columns, rows, empty = 'No records found') {
  if (!rows.length) return `<div class="empty">${empty}</div>`;
  return `<div class="table-wrap"><table><thead><tr>${columns.map((column) => `<th>${column.label}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${column.render(row)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function overview() {
  const { metrics, users, orders, products, deposits } = state.data;
  return `<div class="metric-grid">${[['♙', 'Total users', metrics.userCount], ['▣', 'Total orders', metrics.orderCount], ['⌘', 'Products', metrics.productCount], ['◉', 'Pending deposits', metrics.pendingDeposits]].map(([icon, label, value]) => `<article class="metric"><div class="metric-icon">${icon}</div><div class="metric-label">${label}</div><div class="metric-value">${Number(value).toLocaleString()}</div></article>`).join('')}</div>
  <div class="dashboard-grid"><section class="panel"><div class="panel-head"><div><p class="eyebrow">LATEST ACTIVITY</p><h2>Recent orders</h2></div><span class="pill">${orders.length} shown</span></div>${table([{ label: 'Product', render: (row) => `<strong>${escapeHtml(row.product_name)}</strong>` }, { label: 'Qty', render: (row) => row.qty }, { label: 'Total', render: (row) => money(row.total) }, { label: 'Status', render: (row) => `<span class="pill ${row.status === 'paid' ? 'green' : 'orange'}">${escapeHtml(row.status)}</span>` }], orders)}</section>
  <section class="panel"><div class="panel-head"><div><p class="eyebrow">INVENTORY</p><h2>Products</h2></div><button class="ghost small" data-open-table="products">Manage</button></div>${table([{ label: 'Product', render: (row) => `${escapeHtml(row.emoji ?? '◈')} ${escapeHtml(row.name)}` }, { label: 'Stock', render: (row) => row.stock }, { label: 'Price', render: (row) => money(row.price) }], products)}</section></div>
  <section class="panel" style="margin-top:18px"><div class="panel-head"><div><p class="eyebrow">WALLET</p><h2>Recent deposits</h2></div><button class="ghost small" data-open-table="deposits">Manage</button></div>${table([{ label: 'Method', render: (row) => escapeHtml(row.method) }, { label: 'Amount', render: (row) => money(row.amount) }, { label: 'Status', render: (row) => `<span class="pill ${row.status === 'approved' ? 'green' : 'orange'}">${escapeHtml(row.status)}</span>` }, { label: 'Created', render: (row) => date(row.created_at) }], deposits)}</section>`;
}

function valueFor(row, field) {
  const value = row[field[0]];
  if (field[2] === 'checkbox') return value ? 'Yes' : 'No';
  if (field[2] === 'datetime-local') return date(value);
  if (['price', 'amount', 'total', 'balance'].includes(field[0])) return money(value);
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return escapeHtml(value);
}

function renderTable() {
  const config = state.config[state.section];
  const columns = config.fields.filter((field) => !['textarea', 'datetime-local'].includes(field[2])).slice(0, 7).map((field) => ({ label: field[1], render: (row) => valueFor(row, field) }));
  columns.push({ label: 'Actions', render: (row) => `<div class="actions"><button class="icon-button" data-edit="${escapeHtml(String(row[config.idField]))}">Edit</button><button class="icon-button danger" data-delete="${escapeHtml(String(row[config.idField]))}">Delete</button></div>` });
  const visibleRows = state.search ? state.rows.filter((row) => JSON.stringify(row).toLowerCase().includes(state.search)) : state.rows;
  return `<section class="panel"><div class="panel-head"><div><p class="eyebrow">LIVE DATABASE</p><h2>${config.label}</h2><p class="muted">Edits save to the same Supabase records used by the bot. Telegram bot code is untouched.</p></div><button class="primary compact" data-add>Add ${config.label.replace(/s$/, '')}</button></div><div class="toolbar"><input id="table-search" placeholder="Search this page..." value="${escapeHtml(state.search)}" /><span class="muted">${visibleRows.length} of ${state.total} records</span></div>${table(columns, visibleRows)}<div class="pagination"><button class="ghost small" data-page="-1" ${state.page === 0 ? 'disabled' : ''}>Previous</button><span>Page ${state.page + 1}</span><button class="ghost small" data-page="1" ${(state.page + 1) * 50 >= state.total ? 'disabled' : ''}>Next</button></div></section>`;
}

function renderNavigation() {
  const items = [['overview', '◈', 'Overview'], ...Object.entries(state.config).map(([key, config]) => [key, config.icon, config.label])];
  $('#navigation').innerHTML = items.map(([key, icon, label]) => `<button class="nav-item ${state.section === key ? 'active' : ''}" data-section="${key}">${icon} <span>${label}</span></button>`).join('');
  document.querySelectorAll('[data-section]').forEach((button) => button.addEventListener('click', async () => {
    state.section = button.dataset.section;
    state.page = 0;
    state.search = '';
    if (state.section !== 'overview') await loadTable();
    render();
  }));
}

function render() {
  $('#page-title').textContent = state.section === 'overview' ? 'Overview' : state.config[state.section].label;
  $('#content').innerHTML = state.section === 'overview' ? overview() : renderTable();
  renderNavigation();
  document.querySelectorAll('[data-open-table]').forEach((button) => button.addEventListener('click', () => { state.section = button.dataset.openTable; state.page = 0; loadTable(); }));
  document.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => openEditor(null)));
  document.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => openEditor(state.rows.find((row) => String(row[state.config[state.section].idField]) === button.dataset.edit))));
  document.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', () => deleteRow(button.dataset.delete)));
  document.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => { state.page += Number(button.dataset.page); loadTable(); }));
  $('#table-search')?.addEventListener('input', (event) => { state.search = event.target.value.toLowerCase(); render(); });
}

async function loadTable() {
  const result = await request(`/api/tables/${state.section}?limit=50&offset=${state.page * 50}`);
  state.rows = result.rows;
  state.total = result.count;
  render();
}

function openEditor(row) {
  state.editing = row;
  const config = state.config[state.section];
  const fields = config.fields.map((field) => {
    const [key, label, type, readOnly, options] = field;
    const value = row?.[key] ?? (type === 'checkbox' ? false : '');
    const disabled = readOnly && row ? 'disabled' : '';
    if (type === 'textarea') return `<label>${label}<textarea name="${key}" ${disabled}>${escapeHtml(typeof value === 'object' ? JSON.stringify(value) : value)}</textarea></label>`;
    if (type === 'checkbox') return `<label class="check-label"><input type="checkbox" name="${key}" ${value ? 'checked' : ''} ${disabled} /> ${label}</label>`;
    if (type === 'select') return `<label>${label}<select name="${key}" ${disabled}>${options.map((option) => `<option ${option === value ? 'selected' : ''}>${option}</option>`).join('')}</select></label>`;
    const inputValue = type === 'datetime-local' && value ? new Date(value).toISOString().slice(0, 16) : value;
    return `<label>${label}<input name="${key}" type="${type === 'number' ? 'number' : type}" value="${escapeHtml(inputValue)}" ${disabled} /></label>`;
  }).join('');
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><form class="modal-card" id="editor-form"><div class="panel-head"><h2>${row ? `Edit ${config.label}` : `Add ${config.label}`}</h2><button type="button" class="ghost small" data-close>Close</button></div>${fields}<p id="form-error" class="error"></p><button class="primary" type="submit">Save changes</button></form></div>`;
  $('#editor-form').addEventListener('submit', saveRow);
  $('[data-close]').addEventListener('click', closeEditor);
}

async function saveRow(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = {};
  state.config[state.section].fields.forEach(([key, , type]) => {
    if (type === 'checkbox') payload[key] = form.has(key);
    else if (form.get(key) !== '') payload[key] = type === 'number' ? Number(form.get(key)) : form.get(key);
  });
  try {
    const config = state.config[state.section];
    const id = state.editing?.[config.idField];
    await request(id === undefined ? `/api/tables/${state.section}` : `/api/tables/${state.section}/${encodeURIComponent(id)}`, { method: id === undefined ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    closeEditor();
    await loadTable();
  } catch (error) { $('#form-error').textContent = error.message; }
}

async function deleteRow(id) {
  if (!confirm('Delete this record? This cannot be undone.')) return;
  try { await request(`/api/tables/${state.section}/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadTable(); } catch (error) { alert(error.message); }
}

function closeEditor() { $('#modal-root').innerHTML = ''; state.editing = null; }
async function load() {
  [state.config, state.data] = await Promise.all([request('/api/admin-config').then((result) => result.tables), request('/api/dashboard')]);
  render();
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  const response = await fetch('/api/login', { method: 'POST', body: new URLSearchParams(new FormData(event.currentTarget)) });
  if (!response.ok) { $('#login-error').textContent = 'Invalid username or password.'; return; }
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  await load();
});
$('#logout').addEventListener('click', async () => { await request('/api/logout', { method: 'POST' }); location.reload(); });
$('#refresh').addEventListener('click', load);
request('/api/session').then(load).then(() => { $('#login-view').classList.add('hidden'); $('#app-view').classList.remove('hidden'); }).catch(() => {});

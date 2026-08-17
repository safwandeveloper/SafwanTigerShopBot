const state = { data: null, section: 'overview' };
const $ = (selector) => document.querySelector(selector);
const money = (value) => `$${Number(value ?? 0).toFixed(2)}`;
const date = (value) => value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));

async function request(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) throw new Error('unauthorized');
  if (!response.ok) throw new Error('request failed');
  return response.status === 204 ? null : response.json();
}

function table(columns, rows, empty = 'No records found') {
  if (!rows.length) return `<div class="empty">${empty}</div>`;
  return `<div class="table-wrap"><table><thead><tr>${columns.map((column) => `<th>${column.label}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${column.render(row)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function overview() {
  const { metrics, users, orders, products, deposits } = state.data;
  return `<div class="metric-grid">
    ${[['♙', 'Total users', metrics.userCount], ['▣', 'Total orders', metrics.orderCount], ['⌘', 'Products', metrics.productCount], ['◉', 'Pending deposits', metrics.pendingDeposits]].map(([icon, label, value]) => `<article class="metric"><div class="metric-icon">${icon}</div><div class="metric-label">${label}</div><div class="metric-value">${Number(value).toLocaleString()}</div></article>`).join('')}
  </div>
  <div class="dashboard-grid">
    <section class="panel"><div class="panel-head"><div><p class="eyebrow">LATEST ACTIVITY</p><h2>Recent orders</h2></div><span class="pill">${orders.length} shown</span></div>${table([{ label: 'Product', render: (row) => `<strong>${escapeHtml(row.product_name)}</strong>` }, { label: 'Qty', render: (row) => row.qty }, { label: 'Total', render: (row) => money(row.total) }, { label: 'Status', render: (row) => `<span class="pill ${row.status === 'paid' ? 'green' : 'orange'}">${escapeHtml(row.status)}</span>` }], orders)}</section>
    <section class="panel"><div class="panel-head"><div><p class="eyebrow">INVENTORY</p><h2>Products</h2></div></div>${table([{ label: 'Product', render: (row) => `${escapeHtml(row.emoji ?? '◈')} ${escapeHtml(row.name)}` }, { label: 'Stock', render: (row) => row.stock }, { label: 'Price', render: (row) => money(row.price) }], products)}</section>
  </div>
  <section class="panel" style="margin-top:18px"><div class="panel-head"><div><p class="eyebrow">WALLET</p><h2>Recent deposits</h2></div></div>${table([{ label: 'Method', render: (row) => escapeHtml(row.method) }, { label: 'Amount', render: (row) => money(row.amount) }, { label: 'Status', render: (row) => `<span class="pill ${row.status === 'approved' ? 'green' : 'orange'}">${escapeHtml(row.status)}</span>` }, { label: 'Created', render: (row) => date(row.created_at) }], deposits)}</section>`;
}

const sections = {
  users: ['Users', () => table([{ label: 'Telegram ID', render: (row) => row.telegram_id }, { label: 'User', render: (row) => escapeHtml(row.username ? `@${row.username}` : row.first_name || 'Unnamed') }, { label: 'Balance', render: (row) => `<strong>${money(row.balance)}</strong>` }, { label: 'Last seen', render: (row) => date(row.last_seen_at) }], state.data.users)],
  orders: ['Orders', () => table([{ label: 'ID', render: (row) => `#${row.id}` }, { label: 'Product', render: (row) => escapeHtml(row.product_name) }, { label: 'Qty', render: (row) => row.qty }, { label: 'Total', render: (row) => money(row.total) }, { label: 'Status', render: (row) => `<span class="pill ${row.status === 'paid' ? 'green' : 'orange'}">${escapeHtml(row.status)}</span>` }, { label: 'Created', render: (row) => date(row.created_at) }], state.data.orders)],
  products: ['Products', () => table([{ label: 'Product', render: (row) => `${escapeHtml(row.emoji ?? '◈')} ${escapeHtml(row.name)}` }, { label: 'Price', render: (row) => money(row.price) }, { label: 'Stock', render: (row) => row.stock }, { label: 'Status', render: (row) => `<span class="pill ${row.active ? 'green' : 'orange'}">${row.active ? 'Active' : 'Hidden'}</span>` }], state.data.products)],
  deposits: ['Deposits', () => table([{ label: 'ID', render: (row) => `#${row.id}` }, { label: 'User', render: (row) => row.user_id }, { label: 'Method', render: (row) => escapeHtml(row.method) }, { label: 'Amount', render: (row) => money(row.amount) }, { label: 'Status', render: (row) => `<span class="pill ${row.status === 'approved' ? 'green' : 'orange'}">${escapeHtml(row.status)}</span>` }, { label: 'Created', render: (row) => date(row.created_at) }], state.data.deposits)],
};

function render() {
  const [title, body] = state.section === 'overview' ? ['Overview', overview] : sections[state.section];
  $('#page-title').textContent = title;
  $('#content').innerHTML = state.section === 'overview' ? body() : `<section class="panel"><div class="panel-head"><div><p class="eyebrow">READ-ONLY DATA</p><h2>${title}</h2><p class="muted">This dashboard does not modify the Telegram bot or its existing admin.</p></div></div>${body()}</section>`;
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.section === state.section));
}

async function load() {
  state.data = await request('/api/dashboard');
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
document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => { state.section = button.dataset.section; render(); }));
request('/api/session').then(load).then(() => { $('#login-view').classList.add('hidden'); $('#app-view').classList.remove('hidden'); }).catch(() => {});
